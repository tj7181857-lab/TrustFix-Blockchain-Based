const WEI_PER_ETH = 10n ** 18n;

function formatEther(wei) {
  const value = BigInt(wei);
  const whole = value / WEI_PER_ETH;
  const fraction = (value % WEI_PER_ETH).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function transactionKey(purchase) {
  return `${purchase.eventId}:${purchase.txHash || `log-${purchase.logIndex}`}`;
}

function buildAnalytics(events, purchases, riskScores, clusters) {
  const eventsById = new Map(events.map((event) => [event.eventId, event]));
  const transactions = new Map();
  const buyersByEvent = new Map();
  const buyers = new Set();

  for (const purchase of purchases) {
    const eventId = Number(purchase.eventId);
    const buyer = purchase.buyer.toLowerCase();
    if (!buyersByEvent.has(eventId)) buyersByEvent.set(eventId, new Set());
    buyersByEvent.get(eventId).add(buyer);
    buyers.add(buyer);

    const key = transactionKey(purchase);
    if (!transactions.has(key)) {
      const event = eventsById.get(eventId);
      transactions.set(key, {
        eventId,
        eventName: event?.name ?? `Event #${eventId}`,
        buyer,
        timestamp: Number(purchase.timestamp),
        blockNumber: Number(purchase.blockNumber ?? 0),
        txHash: purchase.txHash,
        ticketIds: [],
        quantity: 0,
        totalPriceWei: 0n,
      });
    }
    const transaction = transactions.get(key);
    transaction.ticketIds.push(Number(purchase.tokenId));
    transaction.quantity += 1;
    transaction.totalPriceWei += BigInt(purchase.priceWei);
    transaction.timestamp = Math.min(transaction.timestamp, Number(purchase.timestamp));
  }

  const purchaseHistory = [...transactions.values()]
    .map((transaction) => ({
      ...transaction,
      ticketIds: transaction.ticketIds.sort((a, b) => a - b),
      totalPriceWei: transaction.totalPriceWei.toString(),
      totalPriceEth: formatEther(transaction.totalPriceWei),
    }))
    .sort((a, b) => b.timestamp - a.timestamp);

  const analyticsEvents = events.map((event) => {
    const sold = Number(event.ticketsSold);
    const supply = Number(event.totalTickets);
    const revenueWei = BigInt(event.ticketsSold) * BigInt(event.ticketPriceWei);
    return {
      ...event,
      uniqueBuyers: buyersByEvent.get(event.eventId)?.size ?? 0,
      purchaseTransactions: purchaseHistory.filter((purchase) => purchase.eventId === event.eventId).length,
      salesPercentage: supply === 0 ? 0 : (sold / supply) * 100,
      revenueWei: revenueWei.toString(),
      revenueEth: formatEther(revenueWei),
      revenueEthNumber: Number(revenueWei) / Number(WEI_PER_ETH),
    };
  });

  const totals = analyticsEvents.reduce((summary, event) => ({
    activeEvents: summary.activeEvents + Number(event.active),
    totalTicketSupply: summary.totalTicketSupply + event.totalTickets,
    totalTicketsSold: summary.totalTicketsSold + event.ticketsSold,
    totalTicketsRemaining: summary.totalTicketsRemaining + event.ticketsAvailable,
    totalRevenueWei: summary.totalRevenueWei + BigInt(event.revenueWei),
  }), {
    activeEvents: 0,
    totalTicketSupply: 0,
    totalTicketsSold: 0,
    totalTicketsRemaining: 0,
    totalRevenueWei: 0n,
  });

  const walletSignals = riskScores.map((risk) => {
    const walletTransactions = purchaseHistory.filter((purchase) =>
      purchase.eventId === Number(risk.eventId) &&
      purchase.buyer === risk.address.toLowerCase()
    );
    return {
      ...risk,
      eventName: eventsById.get(Number(risk.eventId))?.name ?? `Event #${risk.eventId}`,
      ticketsPurchased: Number(risk.purchaseCount),
      purchaseCount: walletTransactions.length,
    };
  });
  const highestRiskByWallet = new Map();
  for (const risk of walletSignals) {
    const address = risk.address.toLowerCase();
    const previous = highestRiskByWallet.get(address);
    if (!previous || risk.score > previous.score) {
      highestRiskByWallet.set(address, risk);
    }
  }
  const globalWalletRisk = [...highestRiskByWallet.values()];

  return {
    status: "ok",
    events: analyticsEvents,
    totals: {
      ...totals,
      totalRevenueWei: totals.totalRevenueWei.toString(),
      totalRevenueEth: formatEther(totals.totalRevenueWei),
      uniqueBuyerWallets: buyers.size,
      totalPurchaseTransactions: purchaseHistory.length,
    },
    purchases: purchaseHistory,
    ticketPurchases: purchases,
    walletSignals,
    riskSummary: {
      trackedWallets: globalWalletRisk.length,
      lowRisk: globalWalletRisk.filter((risk) => risk.riskLevel === "LOW").length,
      mediumRisk: globalWalletRisk.filter((risk) => risk.riskLevel === "MEDIUM").length,
      highRisk: globalWalletRisk.filter((risk) => risk.riskLevel === "HIGH").length,
    },
    clusters,
  };
}

module.exports = { buildAnalytics };
