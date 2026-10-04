const { ethers } = require("ethers");
const EventEmitter = require("events");
const riskEngine = require("./riskEngine");

class ChainListener extends EventEmitter {
  constructor(rpcUrl, contractAddress, abi) {
    super();
    this.rpcUrl = rpcUrl;
    this.contractAddress = contractAddress;
    this.abi = abi;
    this.provider = null;
    this.contract = null;
    this._started = false;
    this._processedLogs = new Set();
    this._originCache = new Map();
  }

  async start() {
    if (this._started) return;
    this.provider = new ethers.JsonRpcProvider(this.rpcUrl);
    this.contract = new ethers.Contract(
      this.contractAddress,
      this.abi,
      this.provider
    );

    const blockNumber = await this.provider.getBlockNumber();
    console.log("[ChainListener] Connected. Current block:", blockNumber);
    const deploymentBlock = Number(process.env.MULTI_EVENT_DEPLOYMENT_BLOCK || 0);
    await this._replayPastEvents(deploymentBlock, blockNumber);
    this._subscribe();
    this._started = true;
    console.log("[ChainListener] Subscribed to multi-event contract events.");
  }

  async stop() {
    if (this.contract) await this.contract.removeAllListeners();
    if (this.provider) this.provider.destroy();
    this._started = false;
  }

  async _replayPastEvents(fromBlock, toBlock) {
    const filter = this.contract.filters.TicketPurchased();
    const events = await this.contract.queryFilter(filter, fromBlock, toBlock);
    console.log(`[ChainListener] Replaying ${events.length} historical purchase log(s).`);
    for (const event of events) {
      await this._processPurchaseLog(event);
    }
  }

  _subscribe() {
    this.contract.on("TicketPurchased", (...args) => {
      const event = args.at(-1);
      this._processPurchaseLog(event).catch((error) => {
        console.error("[ChainListener] Purchase event processing failed:", error);
        this.emit("listenerError", error);
      });
    });

    const lifecycleEvents = [
      ["TicketFrozen", "ticketFrozen"],
      ["TicketCleared", "ticketCleared"],
      ["TicketUsed", "ticketUsed"],
    ];
    for (const [eventName, outputName] of lifecycleEvents) {
      this.contract.on(eventName, (...args) => {
        const event = args.at(-1);
        const parsed = event.log;
        const names = event.fragment.inputs.map((input) => input.name);
        const payload = { eventType: eventName, txHash: parsed.transactionHash };
        names.forEach((name, index) => {
          const value = args[index];
          payload[name] = typeof value === "bigint" ? value.toString() : value;
        });
        this.emit(outputName, payload);
      });
    }

    this.contract.on("TicketRevoked", (...args) => {
      const event = args.at(-1);
      const names = event.fragment.inputs.map((input) => input.name);
      const payload = { eventType: "TicketRevoked", txHash: event.log.transactionHash };
      names.forEach((name, index) => {
        const value = args[index];
        payload[name] = typeof value === "bigint" ? value.toString() : value;
      });
      payload.refundAmountEth = ethers.formatEther(args[4]);
      this.emit("ticketRevoked", payload);
    });
  }

  async _processPurchaseLog(event) {
    const log = event.log ?? event;
    const key = `${log.transactionHash}:${log.index ?? log.logIndex}`;
    if (this._processedLogs.has(key)) return;
    this._processedLogs.add(key);

    const { eventId, tokenId, buyer, seatNumber, price, timestamp } = event.args;
    const purchaseTime = Number(timestamp);
    const { fundingSource, firstSeenAt } = await this._getWalletOrigin(
      buyer,
      purchaseTime
    );
    const purchase = {
      eventId: Number(eventId),
      tokenId: Number(tokenId),
      buyer,
      seatNumber: Number(seatNumber),
      priceEth: ethers.formatEther(price),
      timestamp: purchaseTime,
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
      logIndex: log.index ?? log.logIndex,
      fundingSource,
    };

    riskEngine.recordPurchase(
      purchase.eventId,
      buyer,
      purchase.tokenId,
      purchaseTime,
      fundingSource,
      firstSeenAt,
      { ...purchase, priceWei: price.toString() }
    );
    const risk = riskEngine.calculateRiskScore(purchase.eventId, buyer);
    const data = {
      ...purchase,
      riskScore: risk.score,
      riskLevel: risk.riskLevel,
      signals: risk.signals,
      cluster: risk.cluster,
    };
    this.emit("newPurchase", data);
    if (risk.score >= 60) this.emit("walletFlagged", data);
  }

  async _getWalletOrigin(walletAddress, purchaseTime) {
    const cacheKey = walletAddress.toLowerCase();
    if (this._originCache.has(cacheKey)) return this._originCache.get(cacheKey);

    const currentBlock = await this.provider.getBlockNumber();
    const startBlock = Math.max(
      Number(process.env.ORIGIN_SCAN_START_BLOCK || 0),
      currentBlock - 500
    );
    let fundingSource = null;
    let firstSeenAt = purchaseTime;
    let earliestBlock = currentBlock + 1;

    for (let blockNumber = startBlock; blockNumber <= currentBlock; blockNumber++) {
      const block = await this.provider.getBlock(blockNumber, true);
      if (!block?.prefetchedTransactions) continue;
      for (const tx of block.prefetchedTransactions) {
        if (tx.to?.toLowerCase() === cacheKey && tx.value > 0n && blockNumber < earliestBlock) {
          earliestBlock = blockNumber;
          firstSeenAt = Number(block.timestamp);
          fundingSource = tx.from;
        }
        if (tx.from?.toLowerCase() === cacheKey && blockNumber < earliestBlock) {
          earliestBlock = blockNumber;
          firstSeenAt = Number(block.timestamp);
        }
      }
    }
    const result = { fundingSource, firstSeenAt };
    this._originCache.set(cacheKey, result);
    return result;
  }
}

module.exports = ChainListener;
