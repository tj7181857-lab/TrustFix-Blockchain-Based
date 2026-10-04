const { expect } = require("chai");
const { buildAnalytics } = require("../server/analytics");

describe("Indexed analytics aggregation", function () {
  it("groups multi-ticket transactions and keeps metrics event-scoped", function () {
    const events = [
      {
        eventId: 1,
        name: "First Concert",
        ticketPriceWei: "10000000000000000",
        totalTickets: 10,
        ticketsSold: 3,
        ticketsAvailable: 7,
        active: true,
      },
      {
        eventId: 2,
        name: "Second Festival",
        ticketPriceWei: "20000000000000000",
        totalTickets: 5,
        ticketsSold: 1,
        ticketsAvailable: 4,
        active: true,
      },
    ];
    const purchases = [
      { eventId: 1, buyer: "0xaaa", tokenId: 0, timestamp: 100, priceWei: "10000000000000000", txHash: "0xbulk", logIndex: 0 },
      { eventId: 1, buyer: "0xaaa", tokenId: 1, timestamp: 100, priceWei: "10000000000000000", txHash: "0xbulk", logIndex: 1 },
      { eventId: 1, buyer: "0xbbb", tokenId: 2, timestamp: 110, priceWei: "10000000000000000", txHash: "0xsingle", logIndex: 0 },
      { eventId: 2, buyer: "0xaaa", tokenId: 3, timestamp: 120, priceWei: "20000000000000000", txHash: "0xother", logIndex: 0 },
    ];

    const result = buildAnalytics(events, purchases, [], []);

    expect(result.events[0]).to.include({
      uniqueBuyers: 2,
      purchaseTransactions: 2,
      revenueEth: "0.03",
      salesPercentage: 30,
    });
    expect(result.events[1]).to.include({
      uniqueBuyers: 1,
      purchaseTransactions: 1,
      revenueEth: "0.02",
      salesPercentage: 20,
    });
    expect(result.totals).to.include({
      totalTicketsSold: 4,
      totalTicketsRemaining: 11,
      uniqueBuyerWallets: 2,
      totalPurchaseTransactions: 3,
      totalRevenueEth: "0.05",
    });
    expect(result.purchases.find((purchase) => purchase.txHash === "0xbulk")).to.include({
      quantity: 2,
      totalPriceEth: "0.02",
    });
  });

  it("keeps wallet signals event-scoped and rolls risk cards up by unique wallet", function () {
    const events = [
      { eventId: 1, name: "A", ticketPriceWei: "1", totalTickets: 2, ticketsSold: 1, ticketsAvailable: 1, active: true },
      { eventId: 2, name: "B", ticketPriceWei: "1", totalTickets: 2, ticketsSold: 1, ticketsAvailable: 1, active: true },
      { eventId: 3, name: "C", ticketPriceWei: "1", totalTickets: 2, ticketsSold: 1, ticketsAvailable: 1, active: true },
    ];
    const purchases = [
      { eventId: 1, buyer: "0xaaa", tokenId: 1, timestamp: 100, priceWei: "1", txHash: "0x1", logIndex: 0 },
      { eventId: 2, buyer: "0xaaa", tokenId: 2, timestamp: 101, priceWei: "1", txHash: "0x2", logIndex: 0 },
      { eventId: 3, buyer: "0xbbb", tokenId: 3, timestamp: 102, priceWei: "1", txHash: "0x3", logIndex: 0 },
    ];
    const score = (eventId, address, value, riskLevel) => ({
      eventId, address, score: value, riskLevel, purchaseCount: 1, signals: {},
    });

    const result = buildAnalytics(events, purchases, [
      score(1, "0xaaa", 20, "LOW"),
      score(2, "0xaaa", 35, "MEDIUM"),
      score(3, "0xbbb", 10, "LOW"),
    ], []);

    expect(result.walletSignals.map(({ eventId, address }) => `${eventId}:${address}`))
      .to.have.members(["1:0xaaa", "2:0xaaa", "3:0xbbb"]);
    expect(result.riskSummary).to.deep.equal({
      trackedWallets: 2,
      lowRisk: 1,
      mediumRisk: 1,
      highRisk: 0,
    });
    expect(result.events.map((event) => event.eventId)).to.deep.equal([1, 2, 3]);
    expect(result.totals.totalPurchaseTransactions).to.equal(3);
  });
});
