const { expect } = require("chai");
const riskEngine = require("../server/riskEngine");

describe("Event-scoped riskEngine", function () {
  beforeEach(function () {
    riskEngine.reset();
  });

  after(function () {
    riskEngine.reset();
  });

  it("does not combine shared-funding clusters across different events", function () {
    const source = "0x0000000000000000000000000000000000000001";
    const buyerA = "0x0000000000000000000000000000000000000002";
    const buyerB = "0x0000000000000000000000000000000000000003";
    const buyerC = "0x0000000000000000000000000000000000000004";

    riskEngine.recordPurchase(1, buyerA, 1, 100, source, 0);
    riskEngine.recordPurchase(1, buyerB, 2, 101, source, 0);
    riskEngine.recordPurchase(2, buyerC, 3, 100, source, 0);

    const eventOneClusters = riskEngine.getClusters(1);
    expect(eventOneClusters).to.have.length(1);
    expect(eventOneClusters[0].members).to.have.length(2);
    expect(riskEngine.getClusters(2)).to.deep.equal([]);
    expect(riskEngine.getAllRiskScores(2)).to.have.length(1);
    expect(riskEngine.getAllRiskScores(2)[0].signals.sharedFunding.points).to.equal(0);
  });

  it("rebuilds purchase history with event IDs and event-scoped counts", function () {
    const buyer = "0x0000000000000000000000000000000000000002";
    riskEngine.recordPurchase(7, buyer, 12, 1000, null, 900);
    riskEngine.recordPurchase(7, buyer, 13, 1005, null, 900);

    expect(riskEngine.getPurchases(7)).to.have.length(2);
    expect(riskEngine.getPurchases(8)).to.deep.equal([]);
    expect(riskEngine.calculateRiskScore(7, buyer).purchaseCount).to.equal(2);
    expect(riskEngine.calculateRiskScore(8, buyer).purchaseCount).to.equal(0);
  });
});
