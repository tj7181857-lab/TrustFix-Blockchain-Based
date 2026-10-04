const { expect } = require("chai");
const { ethers } = require("hardhat");
const riskEngine = require("../server/riskEngine");
const { buildAnalytics } = require("../server/analytics");

const PRICE_A = ethers.parseEther("0.01");
const PRICE_B = ethers.parseEther("0.02");

async function deployFixture() {
  const [owner, buyer, otherBuyer, staff, attacker] =
    await ethers.getSigners();
  const TrustTix = await ethers.getContractFactory("TrustTixMultiEvent");
  const trustTix = await TrustTix.deploy();
  await trustTix.waitForDeployment();

  await trustTix.createEvent(
    "First Concert",
    "Hall A",
    "2026-11-01",
    "19:30",
    PRICE_A,
    3,
    2
  );
  await trustTix.createEvent(
    "Second Festival",
    "Park B",
    "2026-12-15",
    "14:00",
    PRICE_B,
    5,
    4
  );
  return { trustTix, owner, buyer, otherBuyer, staff, attacker };
}

async function ticketIdsFor(trustTix, eventId) {
  return trustTix.getAvailableTickets(eventId);
}

describe("TrustTixMultiEvent — event registry", function () {
  it("allows the organizer to create multiple events with unique IDs", async function () {
    const { trustTix } = await deployFixture();
    expect(await trustTix.getEventCount()).to.equal(2);
    expect(await trustTix.getEventIds()).to.deep.equal([1n, 2n]);
  });

  it("stores each event's details and creator", async function () {
    const { trustTix, owner } = await deployFixture();
    const event = await trustTix.getEventDetails(1);
    expect(event.name).to.equal("First Concert");
    expect(event.venue).to.equal("Hall A");
    expect(event.date).to.equal("2026-11-01");
    expect(event.time).to.equal("19:30");
    expect(event.ticketPrice).to.equal(PRICE_A);
    expect(event.totalTickets).to.equal(3);
    expect(event.ticketsSold).to.equal(0);
    expect(event.ticketsAvailable).to.equal(3);
    expect(event.maxTicketsPerWallet).to.equal(2);
    expect(event.active).to.equal(true);
    expect(event.organizer).to.equal(owner.address);
  });

  it("emits EventCreated with the assigned event ID", async function () {
    const TrustTix = await ethers.getContractFactory("TrustTixMultiEvent");
    const contract = await TrustTix.deploy();
    await expect(
      contract.createEvent(
        "New Event",
        "Venue",
        "2026-11-01",
        "19:30",
        PRICE_A,
        2,
        1
      )
    )
      .to.emit(contract, "EventCreated")
      .withArgs(
        1,
        (await ethers.getSigners())[0].address,
        "New Event",
        "Venue",
        "2026-11-01",
        "19:30",
        PRICE_A,
        2,
        1
      );
  });

  it("lists all events and only active events", async function () {
    const { trustTix } = await deployFixture();
    await trustTix.setEventActive(1, false);
    expect(await trustTix.getEventIds()).to.deep.equal([1n, 2n]);
    expect(await trustTix.getActiveEventIds()).to.deep.equal([2n]);
  });

  it("rejects event creation by a non-owner", async function () {
    const { trustTix, attacker } = await deployFixture();
    await expect(
      trustTix
        .connect(attacker)
        .createEvent("Unauthorized", "Venue", "2026-11-01", "19:30", PRICE_A, 2, 1)
    ).to.be.revertedWithCustomError(trustTix, "OwnableUnauthorizedAccount");
  });

  it("rejects empty required fields, zero values, and an excessive wallet limit", async function () {
    const TrustTix = await ethers.getContractFactory("TrustTixMultiEvent");
    const contract = await TrustTix.deploy();
    const create = (name, venue, date, time, price, supply, limit) =>
      contract.createEvent(name, venue, date, time, price, supply, limit);

    await expect(create("", "Venue", "date", "time", PRICE_A, 2, 1))
      .to.be.revertedWith("TrustTix: name is required");
    await expect(create("Name", "", "date", "time", PRICE_A, 2, 1))
      .to.be.revertedWith("TrustTix: venue is required");
    await expect(create("Name", "Venue", "", "time", PRICE_A, 2, 1))
      .to.be.revertedWith("TrustTix: date is required");
    await expect(create("Name", "Venue", "date", "", PRICE_A, 2, 1))
      .to.be.revertedWith("TrustTix: time is required");
    await expect(create("Name", "Venue", "date", "time", 0, 2, 1))
      .to.be.revertedWith("TrustTix: price must be > 0");
    await expect(create("Name", "Venue", "date", "time", PRICE_A, 0, 1))
      .to.be.revertedWith("TrustTix: supply must be > 0");
    await expect(create("Name", "Venue", "date", "time", PRICE_A, 2, 0))
      .to.be.revertedWith("TrustTix: maxPerWallet must be > 0");
    await expect(create("Name", "Venue", "date", "time", PRICE_A, 2, 3))
      .to.be.revertedWith("TrustTix: maxPerWallet exceeds supply");
  });
});

describe("TrustTixMultiEvent — ticket inventory and purchase", function () {
  it("aggregates real indexed purchases across three events", async function () {
    const { trustTix, buyer, otherBuyer } = await deployFixture();
    const owner = (await ethers.getSigners())[0];
    await trustTix.connect(owner).createEvent(
      "Third Exhibition",
      "Gallery C",
      "2027-01-20",
      "17:00",
      PRICE_A,
      4,
      2
    );
    riskEngine.reset();

    const records = [];
    const recordPurchaseLogs = async (receipt) => {
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      for (const log of receipt.logs) {
        const parsed = trustTix.interface.parseLog(log);
        if (parsed?.name !== "TicketPurchased") continue;
        const [eventId, tokenId, wallet, seatNumber, price, timestamp] = parsed.args;
        const record = {
          eventId: Number(eventId),
          tokenId: Number(tokenId),
          buyer: wallet.toLowerCase(),
          seatNumber: Number(seatNumber),
          priceEth: ethers.formatEther(price),
          priceWei: price.toString(),
          timestamp: Number(timestamp),
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          logIndex: log.index,
        };
        records.push(record);
        riskEngine.recordPurchase(
          record.eventId,
          record.buyer,
          record.tokenId,
          record.timestamp,
          null,
          Number(block.timestamp) - 3601,
          record
        );
      }
    };

    const eventOneTickets = await ticketIdsFor(trustTix, 1);
    const eventTwoTickets = await ticketIdsFor(trustTix, 2);
    const eventThreeTickets = await ticketIdsFor(trustTix, 3);
    const eventOneTx = await trustTix.connect(buyer).buyTickets(
      1,
      Array.from(eventOneTickets).slice(0, 2),
      { value: PRICE_A * 2n }
    );
    await recordPurchaseLogs(await eventOneTx.wait());
    const eventTwoTx = await trustTix.connect(otherBuyer).buyTicket(
      2,
      eventTwoTickets[0],
      { value: PRICE_B }
    );
    await recordPurchaseLogs(await eventTwoTx.wait());
    const eventThreeTx = await trustTix.connect(buyer).buyTicket(
      3,
      eventThreeTickets[0],
      { value: PRICE_A }
    );
    await recordPurchaseLogs(await eventThreeTx.wait());

    const events = await Promise.all([1, 2, 3].map(async (eventId) => {
      const details = await trustTix.getEventDetails(eventId);
      return {
        eventId,
        name: details.name,
        ticketPriceWei: details.ticketPrice.toString(),
        totalTickets: Number(details.totalTickets),
        ticketsSold: Number(details.ticketsSold),
        ticketsAvailable: Number(details.ticketsAvailable),
        active: details.active,
      };
    }));
    const analytics = buildAnalytics(
      events,
      riskEngine.getPurchases(),
      riskEngine.getAllRiskScores(),
      riskEngine.getClusters()
    );

    expect(analytics.events.map((event) => event.ticketsSold)).to.deep.equal([2, 1, 1]);
    expect(analytics.events.map((event) => event.uniqueBuyers)).to.deep.equal([1, 1, 1]);
    expect(analytics.events.map((event) => event.purchaseTransactions)).to.deep.equal([1, 1, 1]);
    expect(analytics.walletSignals.map((signal) => signal.eventId).sort()).to.deep.equal([1, 2, 3]);
    expect(analytics.purchases.map((purchase) => purchase.eventId).sort()).to.deep.equal([1, 2, 3]);
    expect(analytics.totals).to.include({
      totalTicketSupply: 12,
      totalTicketsSold: 4,
      totalTicketsRemaining: 8,
      uniqueBuyerWallets: 2,
      totalPurchaseTransactions: 3,
      totalRevenueEth: "0.05",
    });
    expect(analytics.riskSummary).to.include({
      trackedWallets: 2,
      lowRisk: 2,
      mediumRisk: 0,
      highRisk: 0,
    });
    riskEngine.reset();
  });

  it("keeps ticket IDs and inventories associated with their own event", async function () {
    const { trustTix } = await deployFixture();
    const eventATickets = await ticketIdsFor(trustTix, 1);
    const eventBTickets = await ticketIdsFor(trustTix, 2);
    expect(eventATickets).to.have.length(3);
    expect(eventBTickets).to.have.length(5);
    expect((await trustTix.getTicketInfo(eventATickets[0])).eventId).to.equal(1);
    const ticket = await trustTix.getTicketInfo(eventBTickets[0]);
    expect(ticket.eventId).to.equal(2);
  });

  it("sells tickets at the selected event's exact price", async function () {
    const { trustTix, buyer } = await deployFixture();
    const [ticketA] = await ticketIdsFor(trustTix, 1);
    const [ticketB] = await ticketIdsFor(trustTix, 2);

    await trustTix.connect(buyer).buyTicket(1, ticketA, { value: PRICE_A });
    await trustTix.connect(buyer).buyTicket(2, ticketB, { value: PRICE_B });
    expect(await trustTix.ownerOf(ticketA)).to.equal(buyer.address);
    expect(await trustTix.ownerOf(ticketB)).to.equal(buyer.address);
    expect((await trustTix.getTicketInfo(ticketB)).eventId).to.equal(2);
  });

  it("rejects organizer purchases through both single and bulk purchase calls", async function () {
    const { trustTix, owner } = await deployFixture();
    const eventATickets = await ticketIdsFor(trustTix, 1);
    await expect(
      trustTix.connect(owner).buyTicket(1, eventATickets[0], { value: PRICE_A })
    ).to.be.revertedWith("TrustTix: organizer cannot buy tickets");
    await expect(
      trustTix.connect(owner).buyTickets(1, [eventATickets[0]], { value: PRICE_A })
    ).to.be.revertedWith("TrustTix: organizer cannot buy tickets");
    expect(await trustTix.walletTicketCount(1, owner.address)).to.equal(0);
    expect((await trustTix.getEventDetails(1)).ticketsSold).to.equal(0);
  });

  it("emits event ID, token ID, buyer, seat, price and timestamp on purchase", async function () {
    const { trustTix, buyer } = await deployFixture();
    const [tokenId] = await ticketIdsFor(trustTix, 1);
    const tx = await trustTix.connect(buyer).buyTicket(1, tokenId, { value: PRICE_A });
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt.blockNumber);
    await expect(tx)
      .to.emit(trustTix, "TicketPurchased")
      .withArgs(1, tokenId, buyer.address, 1, PRICE_A, block.timestamp);
  });

  it("changes only the selected event's inventory", async function () {
    const { trustTix, buyer } = await deployFixture();
    const [ticketA] = await ticketIdsFor(trustTix, 1);
    await trustTix.connect(buyer).buyTicket(1, ticketA, { value: PRICE_A });
    expect((await trustTix.getEventDetails(1)).ticketsAvailable).to.equal(2);
    expect((await trustTix.getEventDetails(2)).ticketsAvailable).to.equal(5);
  });

  it("enforces wallet limits independently for each event", async function () {
    const { trustTix, buyer } = await deployFixture();
    const eventATickets = await ticketIdsFor(trustTix, 1);
    const eventBTickets = await ticketIdsFor(trustTix, 2);
    await trustTix.connect(buyer).buyTickets(1, Array.from(eventATickets).slice(0, 2), {
      value: PRICE_A * 2n,
    });
    await expect(
      trustTix.connect(buyer).buyTicket(1, eventATickets[2], { value: PRICE_A })
    ).to.be.revertedWith("TrustTix: wallet ticket limit reached");
    await trustTix.connect(buyer).buyTickets(2, Array.from(eventBTickets).slice(0, 4), {
      value: PRICE_B * 4n,
    });
    expect(await trustTix.walletTicketCount(1, buyer.address)).to.equal(2);
    expect(await trustTix.walletTicketCount(2, buyer.address)).to.equal(4);
  });

  it("rejects incorrect payment and invalid bulk quantity", async function () {
    const { trustTix, buyer } = await deployFixture();
    const eventATickets = await ticketIdsFor(trustTix, 1);
    await expect(
      trustTix.connect(buyer).buyTicket(1, eventATickets[0], { value: PRICE_B })
    ).to.be.revertedWith("TrustTix: incorrect payment amount");
    await expect(
      trustTix.connect(buyer).buyTickets(1, [], { value: 0 })
    ).to.be.revertedWith("TrustTix: quantity must be > 0");
    await expect(
      trustTix.connect(buyer).buyTickets(1, Array.from(eventATickets), {
        value: PRICE_A * 3n,
      })
    ).to.be.revertedWith("TrustTix: wallet ticket limit reached");
  });

  it("rejects a ticket ID from a different event", async function () {
    const { trustTix, buyer } = await deployFixture();
    const [, ticketB] = await ticketIdsFor(trustTix, 2);
    await expect(
      trustTix.connect(buyer).buyTicket(1, ticketB, { value: PRICE_A })
    ).to.be.revertedWith("TrustTix: ticket belongs to another event");
  });

  it("rejects purchases for inactive or nonexistent events", async function () {
    const { trustTix, buyer } = await deployFixture();
    const [ticket] = await ticketIdsFor(trustTix, 1);
    await trustTix.setEventActive(1, false);
    await expect(
      trustTix.connect(buyer).buyTicket(1, ticket, { value: PRICE_A })
    ).to.be.revertedWith("TrustTix: event is inactive");
    await expect(trustTix.getEventDetails(99)).to.be.revertedWith(
      "TrustTix: event does not exist"
    );
  });

  it("keeps inactive event tickets and ownership state queryable", async function () {
    const { trustTix, buyer } = await deployFixture();
    const [ticket] = await ticketIdsFor(trustTix, 1);
    await trustTix.connect(buyer).buyTicket(1, ticket, { value: PRICE_A });
    await trustTix.setEventActive(1, false);
    expect(await trustTix.ownerOf(ticket)).to.equal(buyer.address);
    expect((await trustTix.getTicketInfo(ticket)).status).to.equal(1);
  });

  it("rejects a bulk purchase exceeding the available supply", async function () {
    const { trustTix, buyer } = await deployFixture();
    const tickets = await ticketIdsFor(trustTix, 2);
    await expect(
      trustTix.connect(buyer).buyTickets(2, [...tickets, 999], {
        value: PRICE_B * 6n,
      })
    ).to.be.revertedWith("TrustTix: insufficient tickets available");
  });
});

describe("TrustTixMultiEvent — ownership, staff and ticket lifecycle", function () {
  it("returns purchased tickets for the correct event and owner", async function () {
    const { trustTix, buyer } = await deployFixture();
    const [ticketA] = await ticketIdsFor(trustTix, 1);
    const [ticketB] = await ticketIdsFor(trustTix, 2);
    await trustTix.connect(buyer).buyTicket(1, ticketA, { value: PRICE_A });
    await trustTix.connect(buyer).buyTicket(2, ticketB, { value: PRICE_B });
    expect(await trustTix.getWalletTickets(1, buyer.address)).to.deep.equal([ticketA]);
    expect(await trustTix.getWalletTickets(2, buyer.address)).to.deep.equal([ticketB]);
  });

  it("counts transferred tickets against the recipient's event-specific limit", async function () {
    const { trustTix, buyer, otherBuyer } = await deployFixture();
    const [ticket] = await ticketIdsFor(trustTix, 1);
    await trustTix.connect(buyer).buyTicket(1, ticket, { value: PRICE_A });
    await trustTix.connect(buyer).transferFrom(buyer.address, otherBuyer.address, ticket);
    expect(await trustTix.walletTicketCount(1, buyer.address)).to.equal(0);
    expect(await trustTix.walletTicketCount(1, otherBuyer.address)).to.equal(1);
  });

  it("enforces the event limit on ticket transfers", async function () {
    const { trustTix, buyer, otherBuyer } = await deployFixture();
    const tickets = await ticketIdsFor(trustTix, 1);
    await trustTix.connect(buyer).buyTickets(1, Array.from(tickets).slice(0, 2), {
      value: PRICE_A * 2n,
    });
    await trustTix.connect(otherBuyer).buyTicket(1, tickets[2], { value: PRICE_A });
    await expect(
      trustTix.connect(otherBuyer).transferFrom(otherBuyer.address, buyer.address, tickets[2])
    ).to.be.revertedWith("TrustTix: recipient event ticket limit reached");
  });

  it("allows owner-approved staff to use a ticket once", async function () {
    const { trustTix, buyer, staff } = await deployFixture();
    const [ticket] = await ticketIdsFor(trustTix, 1);
    await trustTix.connect(buyer).buyTicket(1, ticket, { value: PRICE_A });
    await trustTix.addStaff(staff.address);
    await expect(trustTix.connect(staff).markUsed(ticket))
      .to.emit(trustTix, "TicketUsed");
    await expect(trustTix.connect(staff).markUsed(ticket)).to.be.revertedWith(
      "TrustTix: ticket must be SOLD to mark used"
    );
  });

  it("does not allow an unauthorized wallet to use a ticket", async function () {
    const { trustTix, buyer, attacker } = await deployFixture();
    const [ticket] = await ticketIdsFor(trustTix, 1);
    await trustTix.connect(buyer).buyTicket(1, ticket, { value: PRICE_A });
    await expect(trustTix.connect(attacker).markUsed(ticket)).to.be.revertedWith(
      "TrustTix: caller is not staff or owner"
    );
  });

  it("preserves freeze, clear, and transfer restrictions", async function () {
    const { trustTix, buyer, otherBuyer } = await deployFixture();
    const [ticket] = await ticketIdsFor(trustTix, 1);
    await trustTix.connect(buyer).buyTicket(1, ticket, { value: PRICE_A });
    await trustTix.freezeTicket(ticket);
    await expect(
      trustTix.connect(buyer).transferFrom(buyer.address, otherBuyer.address, ticket)
    ).to.be.revertedWith("TrustTix: frozen tickets cannot be transferred");
    await trustTix.clearFlag(ticket);
    await trustTix.connect(buyer).transferFrom(buyer.address, otherBuyer.address, ticket);
    expect(await trustTix.ownerOf(ticket)).to.equal(otherBuyer.address);
  });

  it("revokes, refunds and re-pools a replacement ticket for the same event", async function () {
    const { trustTix, buyer } = await deployFixture();
    const [ticket] = await ticketIdsFor(trustTix, 1);
    await trustTix.connect(buyer).buyTicket(1, ticket, { value: PRICE_A });
    const before = await ethers.provider.getBalance(buyer.address);
    const tx = await trustTix.revokeAndRefund(ticket);
    const receipt = await tx.wait();
    const after = await ethers.provider.getBalance(buyer.address);
    expect(after).to.equal(before + PRICE_A);
    expect((await trustTix.getEventDetails(1)).ticketsAvailable).to.equal(3);
    expect((await trustTix.getEventDetails(1)).ticketsSold).to.equal(0);
    await expect(trustTix.ownerOf(ticket)).to.be.reverted;
    const replacement = Array.from(await trustTix.getAvailableTickets(1)).at(-1);
    expect((await trustTix.getTicketInfo(replacement)).eventId).to.equal(1);
    expect((await trustTix.getTicketInfo(replacement)).seatNumber).to.equal(1);
    expect(receipt.logs.length).to.be.greaterThan(0);
  });

  it("rejects organizer actions from a non-owner", async function () {
    const { trustTix, attacker } = await deployFixture();
    await expect(trustTix.connect(attacker).setEventActive(1, false))
      .to.be.revertedWithCustomError(trustTix, "OwnableUnauthorizedAccount");
    await expect(trustTix.connect(attacker).addStaff(attacker.address))
      .to.be.revertedWithCustomError(trustTix, "OwnableUnauthorizedAccount");
  });

  it("restricts freeze, clear, and revoke operations to the organizer", async function () {
    const { trustTix, buyer, attacker } = await deployFixture();
    const [ticket] = await ticketIdsFor(trustTix, 1);
    await trustTix.connect(buyer).buyTicket(1, ticket, { value: PRICE_A });
    await expect(trustTix.connect(attacker).freezeTicket(ticket))
      .to.be.revertedWithCustomError(trustTix, "OwnableUnauthorizedAccount");
    await trustTix.freezeTicket(ticket);
    await expect(trustTix.connect(attacker).clearFlag(ticket))
      .to.be.revertedWithCustomError(trustTix, "OwnableUnauthorizedAccount");
    await expect(trustTix.connect(attacker).revokeAndRefund(ticket))
      .to.be.revertedWithCustomError(trustTix, "OwnableUnauthorizedAccount");
  });

  it("revokes a removed staff member's gate permission", async function () {
    const { trustTix, buyer, staff } = await deployFixture();
    const [ticket] = await ticketIdsFor(trustTix, 1);
    await trustTix.connect(buyer).buyTicket(1, ticket, { value: PRICE_A });
    await trustTix.addStaff(staff.address);
    await trustTix.removeStaff(staff.address);
    await expect(trustTix.connect(staff).markUsed(ticket)).to.be.revertedWith(
      "TrustTix: caller is not staff or owner"
    );
  });

  it("prevents used tickets from being transferred", async function () {
    const { trustTix, buyer, otherBuyer } = await deployFixture();
    const [ticket] = await ticketIdsFor(trustTix, 1);
    await trustTix.connect(buyer).buyTicket(1, ticket, { value: PRICE_A });
    await trustTix.markUsed(ticket);
    await expect(
      trustTix.connect(buyer).transferFrom(buyer.address, otherBuyer.address, ticket)
    ).to.be.revertedWith("TrustTix: used tickets cannot be transferred");
  });
});
