/**
 * Event-scoped heuristic risk signals derived only from processed purchase
 * logs. A shared funding source is a relationship signal, not identity proof.
 */
const wallets = new Map();
const fundingClusters = new Map();

function walletKey(eventId, address) {
  return `${eventId}:${address.toLowerCase()}`;
}

function clusterKey(eventId, source) {
  return `${eventId}:${source.toLowerCase()}`;
}

function recordPurchase(
  eventId,
  buyerAddress,
  tokenId,
  purchaseTime,
  fundingSource = null,
  firstSeenAt = null,
  details = {}
) {
  const address = buyerAddress.toLowerCase();
  const source = fundingSource ? fundingSource.toLowerCase() : null;
  const key = walletKey(eventId, address);
  if (!wallets.has(key)) {
    wallets.set(key, {
      eventId: Number(eventId),
      address,
      fundingSource: source,
      firstSeenAt: firstSeenAt ?? purchaseTime,
      purchases: [],
    });
  }

  const wallet = wallets.get(key);
  if (!wallet.fundingSource && source) wallet.fundingSource = source;
  if (firstSeenAt && firstSeenAt < wallet.firstSeenAt) {
    wallet.firstSeenAt = firstSeenAt;
  }
  wallet.purchases.push({
    eventId: Number(eventId),
    tokenId: Number(tokenId),
    timestamp: Number(purchaseTime),
    priceEth: details.priceEth ?? null,
    priceWei: details.priceWei ?? null,
    seatNumber: details.seatNumber ?? null,
    txHash: details.txHash ?? null,
    blockNumber: details.blockNumber ?? null,
    logIndex: details.logIndex ?? null,
  });

  if (source) {
    const key = clusterKey(eventId, source);
    if (!fundingClusters.has(key)) {
      fundingClusters.set(key, { eventId: Number(eventId), source, members: new Set() });
    }
    fundingClusters.get(key).members.add(address);
  }
}

function calculateRiskScore(eventId, buyerAddress) {
  const address = buyerAddress.toLowerCase();
  const data = wallets.get(walletKey(eventId, address));
  if (!data) {
    return {
      eventId: Number(eventId),
      address,
      score: 0,
      riskLevel: "LOW",
      signals: {},
      cluster: [],
      fundingSource: null,
      purchaseCount: 0,
    };
  }

  let score = 0;
  const signals = {};
  const cluster = data.fundingSource
    ? fundingClusters.get(clusterKey(eventId, data.fundingSource))?.members
    : null;
  const clusterMates = cluster ? [...cluster].filter((member) => member !== address) : [];
  const clusterSize = cluster?.size ?? 1;
  const sharedPoints = clusterSize >= 3 ? 40 : clusterSize === 2 ? 20 : 0;
  signals.sharedFunding = {
    points: sharedPoints,
    detail: sharedPoints
      ? `Shared funding source with ${clusterMates.length} other event buyer(s)`
      : "No shared funding source detected for this event",
  };
  score += sharedPoints;

  let timingPoints = 0;
  let timingDetail = "No closely timed purchases in this event";
  for (const mateAddress of clusterMates) {
    const mate = wallets.get(walletKey(eventId, mateAddress));
    for (const purchase of data.purchases) {
      for (const matePurchase of mate?.purchases ?? []) {
        const difference = Math.abs(purchase.timestamp - matePurchase.timestamp);
        if (difference <= 10) {
          timingPoints = 30;
          timingDetail = `Purchase within ${difference}s of another wallet in this event`;
          break;
        }
        if (difference <= 60 && timingPoints < 15) {
          timingPoints = 15;
          timingDetail = `Purchase within ${difference}s of another wallet in this event`;
        }
      }
      if (timingPoints === 30) break;
    }
    if (timingPoints === 30) break;
  }
  signals.burstTiming = { points: timingPoints, detail: timingDetail };
  score += timingPoints;

  const firstPurchase = Math.min(...data.purchases.map((purchase) => purchase.timestamp));
  const walletAge = Math.max(0, firstPurchase - data.firstSeenAt);
  const newWalletPoints = walletAge < 600 ? 20 : walletAge < 3600 ? 10 : 0;
  signals.newWallet = {
    points: newWalletPoints,
    detail: newWalletPoints
      ? "Wallet activity was first observed shortly before this event purchase"
      : "Wallet has more than one hour of observed activity before purchase",
  };
  score += newWalletPoints;

  const count = data.purchases.length;
  const repeatedPurchasePoints = count >= 4 ? 10 : count >= 2 ? 5 : 0;
  signals.purchaseFrequency = {
    points: repeatedPurchasePoints,
    detail: `${count} ticket purchase${count === 1 ? "" : "s"} for this event`,
  };
  score += repeatedPurchasePoints;
  score = Math.min(100, score);

  return {
    eventId: Number(eventId),
    address,
    score,
    riskLevel: score >= 60 ? "HIGH" : score >= 30 ? "MEDIUM" : "LOW",
    signals,
    cluster: clusterMates,
    fundingSource: data.fundingSource,
    purchaseCount: count,
  };
}

function getAllRiskScores(eventId = null) {
  const results = [];
  for (const wallet of wallets.values()) {
    if (eventId != null && wallet.eventId !== Number(eventId)) continue;
    results.push(calculateRiskScore(wallet.eventId, wallet.address));
  }
  return results.sort((a, b) => b.score - a.score);
}

function getClusters(eventId = null) {
  const results = [];
  for (const entry of fundingClusters.values()) {
    if (eventId != null && entry.eventId !== Number(eventId)) continue;
    if (entry.members.size < 2) continue;
    const members = [...entry.members];
    results.push({
      eventId: entry.eventId,
      source: entry.source,
      members,
      maxScore: Math.max(
        ...members.map((address) => calculateRiskScore(entry.eventId, address).score)
      ),
    });
  }
  return results.sort((a, b) => b.maxScore - a.maxScore);
}

function getGraphData(eventId = null) {
  const nodes = new Map();
  const edges = [];
  for (const wallet of wallets.values()) {
    if (eventId != null && wallet.eventId !== Number(eventId)) continue;
    const risk = calculateRiskScore(wallet.eventId, wallet.address);
    const id = walletKey(wallet.eventId, wallet.address);
    nodes.set(id, {
      id,
      eventId: wallet.eventId,
      label: `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`,
      type: "buyer",
      score: risk.score,
      riskLevel: risk.riskLevel,
      purchaseCount: wallet.purchases.length,
    });
  }
  for (const entry of fundingClusters.values()) {
    if (eventId != null && entry.eventId !== Number(eventId)) continue;
    if (entry.members.size < 2) continue;
    const sourceId = `${entry.eventId}:source:${entry.source}`;
    nodes.set(sourceId, {
      id: sourceId,
      eventId: entry.eventId,
      label: `Funding source ${entry.source.slice(0, 6)}…${entry.source.slice(-4)}`,
      type: "source",
      score: 0,
      riskLevel: "SOURCE",
      purchaseCount: 0,
    });
    for (const address of entry.members) {
      edges.push({
        id: `${sourceId}->${walletKey(entry.eventId, address)}`,
        from: sourceId,
        to: walletKey(entry.eventId, address),
        label: "shared funding source",
        eventId: entry.eventId,
      });
    }
  }
  return { nodes: [...nodes.values()], edges };
}

function getPurchases(eventId = null) {
  const purchases = [];
  for (const wallet of wallets.values()) {
    if (eventId != null && wallet.eventId !== Number(eventId)) continue;
    for (const purchase of wallet.purchases) {
      const risk = calculateRiskScore(wallet.eventId, wallet.address);
      purchases.push({ ...purchase, buyer: wallet.address, riskScore: risk.score, riskLevel: risk.riskLevel });
    }
  }
  return purchases.sort((a, b) => b.timestamp - a.timestamp);
}

function getAllWalletData() {
  return [...wallets.values()];
}

function reset() {
  wallets.clear();
  fundingClusters.clear();
}

module.exports = {
  recordPurchase,
  calculateRiskScore,
  getAllRiskScores,
  getClusters,
  getGraphData,
  getPurchases,
  getAllWalletData,
  reset,
};
