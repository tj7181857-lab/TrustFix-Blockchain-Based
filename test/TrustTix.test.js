const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  loadFixture,
} = require("@nomicfoundation/hardhat-toolbox/network-helpers");

// ─── constants ────────────────────────────────────────────────────────────────

const PRICE = ethers.parseEther("0.01"); // 0.01 ETH per ticket
const MAX_PER_WALLET = 2;
const TOTAL_TICKETS = 10;

// ─── fixture ──────────────────────────────────────────────────────────────────

/**
 * Deploy TrustTix and create a demo event.
 * Hardhat loadFixture snapshots state after this runs and re-uses it
 * for speed rather than redeploying for every single test.
 */
async function deployFixture() {
  const [owner, buyer1, buyer2, buyer3, staff, attacker] =
    await ethers.getSigners();

  const TrustTix = await ethers.getContractFactory("TrustTix");
  const trustTix = await TrustTix.deploy();
  await trustTix.waitForDeployment();

  await trustTix.createEvent(
    "Demo Concert",
    TOTAL_TICKETS,
    PRICE,
    MAX_PER_WALLET
  );

  return { trustTix, owner, buyer1, buyer2, buyer3, staff, attacker };
}

// ─── Deployment & Setup ───────────────────────────────────────────────────────

describe("TrustTix — Deployment & Setup", function () {
  it("deploys with correct ERC-721 name/symbol", async function () {
    const { trustTix } = await loadFixture(deployFixture);
    expect(await trustTix.name()).to.equal("TrustTix");
    expect(await trustTix.symbol()).to.equal("TTIX");
  });

  it("creates event with correct parameters", async function () {
    const { trustTix } = await loadFixture(deployFixture);
    const info = await trustTix.getEventInfo();
    expect(info.name).to.equal("Demo Concert");
    expect(info.totalTickets).to.equal(TOTAL_TICKETS);
    expect(info.priceInWei).to.equal(PRICE);
    expect(info.maxPerWallet).to.equal(MAX_PER_WALLET);
    expect(info.ticketsSold).to.equal(0);
    expect(info.ticketsAvailable).to.equal(TOTAL_TICKETS);
    expect(info.active).to.equal(true);
  });

  it("pre-mints all tickets into the available pool", async function () {
    const { trustTix } = await loadFixture(deployFixture);
    const available = await trustTix.getAvailableTickets();
    expect(available.length).to.equal(TOTAL_TICKETS);
  });

  it("rejects a second createEvent call", async function () {
    const { trustTix } = await loadFixture(deployFixture);
    await expect(
      trustTix.createEvent("Another Event", 5, PRICE, 1)
    ).to.be.revertedWith("TrustTix: event already created");
  });

  it("rejects createEvent from non-owner", async function () {
    const TrustTix = await ethers.getContractFactory("TrustTix");
    const contract = await TrustTix.deploy();
    const [, notOwner] = await ethers.getSigners();
    await expect(
      contract.connect(notOwner).createEvent("Hack", 5, PRICE, 1)
    ).to.be.revertedWithCustomError(contract, "OwnableUnauthorizedAccount");
  });
});

// ─── Normal Purchase Flow ─────────────────────────────────────────────────────

describe("TrustTix — Normal Purchase Flow", function () {
  it("allows a buyer to purchase with exact payment and emits TicketPurchased", async function () {
    const { trustTix, buyer1 } = await loadFixture(deployFixture);
    const available = await trustTix.getAvailableTickets();
    const tokenId = available[0];

    const tx = await trustTix
      .connect(buyer1)
      .buyTicket(tokenId, { value: PRICE });
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt.blockNumber);

    await expect(tx)
      .to.emit(trustTix, "TicketPurchased")
      .withArgs(tokenId, buyer1.address, 1n, PRICE, BigInt(block.timestamp));

    expect(await trustTix.ownerOf(tokenId)).to.equal(buyer1.address);
  });

  it("updates event counters (ticketsSold / ticketsAvailable)", async function () {
    const { trustTix, buyer1 } = await loadFixture(deployFixture);
    const available = await trustTix.getAvailableTickets();
    await trustTix.connect(buyer1).buyTicket(available[0], { value: PRICE });

    const info = await trustTix.getEventInfo();
    expect(info.ticketsSold).to.equal(1);
    expect(info.ticketsAvailable).to.equal(TOTAL_TICKETS - 1);
  });

  it("removes ticket from available pool after purchase", async function () {
    const { trustTix, buyer1 } = await loadFixture(deployFixture);
    const before = await trustTix.getAvailableTickets();
    const tokenId = before[0];

    await trustTix.connect(buyer1).buyTicket(tokenId, { value: PRICE });

    const after = await trustTix.getAvailableTickets();
    expect(after.length).to.equal(before.length - 1);
    expect(after.map((id) => id.toString())).to.not.include(
      tokenId.toString()
    );
  });

  it("reflects purchased ticket in buyer's wallet", async function () {
    const { trustTix, buyer1 } = await loadFixture(deployFixture);
    const available = await trustTix.getAvailableTickets();
    await trustTix.connect(buyer1).buyTicket(available[0], { value: PRICE });

    const walletTickets = await trustTix.getWalletTickets(buyer1.address);
    expect(walletTickets.length).to.equal(1);
  });

  it("allows buying a second ticket up to the limit", async function () {
    const { trustTix, buyer1 } = await loadFixture(deployFixture);
    const available = await trustTix.getAvailableTickets();
    await trustTix.connect(buyer1).buyTicket(available[0], { value: PRICE });
    await trustTix.connect(buyer1).buyTicket(available[1], { value: PRICE });

    const walletTickets = await trustTix.getWalletTickets(buyer1.address);
    expect(walletTickets.length).to.equal(2);
  });

  it("rejects purchase with too little ETH", async function () {
    const { trustTix, buyer1 } = await loadFixture(deployFixture);
    const available = await trustTix.getAvailableTickets();
    await expect(
      trustTix
        .connect(buyer1)
        .buyTicket(available[0], { value: ethers.parseEther("0.005") })
    ).to.be.revertedWith("TrustTix: incorrect payment amount");
  });

  it("rejects purchase with too much ETH", async function () {
    const { trustTix, buyer1 } = await loadFixture(deployFixture);
    const available = await trustTix.getAvailableTickets();
    await expect(
      trustTix
        .connect(buyer1)
        .buyTicket(available[0], { value: ethers.parseEther("0.02") })
    ).to.be.revertedWith("TrustTix: incorrect payment amount");
  });

  it("rejects buying an already-sold ticket", async function () {
    const { trustTix, buyer1, buyer2 } = await loadFixture(deployFixture);
    const available = await trustTix.getAvailableTickets();
    const tokenId = available[0];

    await trustTix.connect(buyer1).buyTicket(tokenId, { value: PRICE });

    await expect(
      trustTix.connect(buyer2).buyTicket(tokenId, { value: PRICE })
    ).to.be.revertedWith("TrustTix: ticket not available");
  });

  it("stores correct ticket info after purchase", async function () {
    const { trustTix, buyer1 } = await loadFixture(deployFixture);
    const available = await trustTix.getAvailableTickets();
    const tokenId = available[0];

    const tx = await trustTix
      .connect(buyer1)
      .buyTicket(tokenId, { value: PRICE });
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt.blockNumber);

    const info = await trustTix.getTicketInfo(tokenId);
    expect(info.status).to.equal(1n); // SOLD = 1
    expect(info.owner).to.equal(buyer1.address);
    expect(info.pricePaid).to.equal(PRICE);
    expect(info.purchaseTime).to.equal(BigInt(block.timestamp));
  });

  it("holds ETH in the contract after purchases", async function () {
    const { trustTix, buyer1, buyer2 } = await loadFixture(deployFixture);
    const available = await trustTix.getAvailableTickets();
    await trustTix.connect(buyer1).buyTicket(available[0], { value: PRICE });
    await trustTix.connect(buyer2).buyTicket(available[1], { value: PRICE });

    const balance = await ethers.provider.getBalance(
      await trustTix.getAddress()
    );
    expect(balance).to.equal(PRICE * 2n);
  });
});

// ─── Wallet Limit Enforcement (on-chain) ─────────────────────────────────────

describe("TrustTix — Wallet Limit Enforcement (on-chain)", function () {
  it("rejects a 3rd ticket from the same wallet when maxPerWallet = 2", async function () {
    const { trustTix, buyer1 } = await loadFixture(deployFixture);
    const available = await trustTix.getAvailableTickets();

    await trustTix.connect(buyer1).buyTicket(available[0], { value: PRICE });
    await trustTix.connect(buyer1).buyTicket(available[1], { value: PRICE });

    // Third purchase must revert ON-CHAIN
    await expect(
      trustTix.connect(buyer1).buyTicket(available[2], { value: PRICE })
    ).to.be.revertedWith("TrustTix: wallet ticket limit reached");
  });

  it("allows different wallets to each hit the limit independently", async function () {
    const { trustTix, buyer1, buyer2 } = await loadFixture(deployFixture);
    const available = await trustTix.getAvailableTickets();

    await trustTix.connect(buyer1).buyTicket(available[0], { value: PRICE });
    await trustTix.connect(buyer1).buyTicket(available[1], { value: PRICE });
    await trustTix.connect(buyer2).buyTicket(available[2], { value: PRICE });
    await trustTix.connect(buyer2).buyTicket(available[3], { value: PRICE });

    expect(await trustTix.getWalletTickets(buyer1.address)).to.have.length(2);
    expect(await trustTix.getWalletTickets(buyer2.address)).to.have.length(2);
  });
});

// ─── Freeze & Clear Flag ──────────────────────────────────────────────────────

describe("TrustTix — Freeze & Clear Flag", function () {
  /** Buy one ticket and return the fixture with the tokenId included. */
  async function withPurchase() {
    const base = await loadFixture(deployFixture);
    const available = await base.trustTix.getAvailableTickets();
    const tokenId = available[0];
    await base.trustTix
      .connect(base.buyer1)
      .buyTicket(tokenId, { value: PRICE });
    return { ...base, tokenId };
  }

  it("allows owner to freeze a sold ticket and emits TicketFrozen", async function () {
    const { trustTix, owner, buyer1, tokenId } = await withPurchase();

    const tx = await trustTix.connect(owner).freezeTicket(tokenId);
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt.blockNumber);

    await expect(tx)
      .to.emit(trustTix, "TicketFrozen")
      .withArgs(tokenId, buyer1.address, BigInt(block.timestamp));

    const info = await trustTix.getTicketInfo(tokenId);
    expect(info.status).to.equal(2n); // FROZEN = 2
  });

  it("blocks transfer of a frozen ticket", async function () {
    const { trustTix, owner, buyer1, buyer2, tokenId } = await withPurchase();
    await trustTix.connect(owner).freezeTicket(tokenId);

    await expect(
      trustTix
        .connect(buyer1)
        .transferFrom(buyer1.address, buyer2.address, tokenId)
    ).to.be.revertedWith("TrustTix: frozen tickets cannot be transferred");
  });

  it("blocks markUsed on a frozen ticket", async function () {
    const { trustTix, owner, tokenId } = await withPurchase();
    await trustTix.connect(owner).freezeTicket(tokenId);

    await expect(
      trustTix.connect(owner).markUsed(tokenId)
    ).to.be.revertedWith("TrustTix: ticket must be SOLD to mark used");
  });

  it("rejects freezing an AVAILABLE ticket", async function () {
    const { trustTix, owner } = await loadFixture(deployFixture);
    const available = await trustTix.getAvailableTickets();
    await expect(
      trustTix.connect(owner).freezeTicket(available[0])
    ).to.be.revertedWith("TrustTix: ticket must be SOLD to freeze");
  });

  it("allows owner to clear a frozen ticket (false positive) and emits TicketCleared", async function () {
    const { trustTix, owner, buyer1, tokenId } = await withPurchase();
    await trustTix.connect(owner).freezeTicket(tokenId);

    const tx = await trustTix.connect(owner).clearFlag(tokenId);
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt.blockNumber);

    await expect(tx)
      .to.emit(trustTix, "TicketCleared")
      .withArgs(tokenId, buyer1.address, BigInt(block.timestamp));

    const info = await trustTix.getTicketInfo(tokenId);
    expect(info.status).to.equal(1n); // Back to SOLD
  });

  it("allows transfer after clearFlag", async function () {
    const { trustTix, owner, buyer1, buyer2, tokenId } = await withPurchase();
    await trustTix.connect(owner).freezeTicket(tokenId);
    await trustTix.connect(owner).clearFlag(tokenId);

    await expect(
      trustTix
        .connect(buyer1)
        .transferFrom(buyer1.address, buyer2.address, tokenId)
    ).to.not.be.reverted;
  });

  it("rejects clearFlag on a non-frozen ticket", async function () {
    const { trustTix, owner, tokenId } = await withPurchase();
    await expect(
      trustTix.connect(owner).clearFlag(tokenId)
    ).to.be.revertedWith("TrustTix: ticket must be FROZEN to clear");
  });

  it("rejects freeze by non-owner", async function () {
    const { trustTix, buyer2, tokenId } = await withPurchase();
    await expect(
      trustTix.connect(buyer2).freezeTicket(tokenId)
    ).to.be.revertedWithCustomError(trustTix, "OwnableUnauthorizedAccount");
  });
});

// ─── Revoke & Refund + Re-pooling ─────────────────────────────────────────────

describe("TrustTix — Revoke & Refund + Re-pooling", function () {
  it("refunds the buyer and emits TicketRevoked", async function () {
    const { trustTix, owner, buyer1 } = await loadFixture(deployFixture);
    const avail = await trustTix.getAvailableTickets();
    const tokenId = avail[0];
    await trustTix.connect(buyer1).buyTicket(tokenId, { value: PRICE });

    const balanceBefore = await ethers.provider.getBalance(buyer1.address);
    const tx = await trustTix.connect(owner).revokeAndRefund(tokenId);
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt.blockNumber);

    await expect(tx)
      .to.emit(trustTix, "TicketRevoked")
      .withArgs(tokenId, buyer1.address, PRICE, BigInt(block.timestamp));

    const balanceAfter = await ethers.provider.getBalance(buyer1.address);
    expect(balanceAfter - balanceBefore).to.equal(PRICE);
  });

  it("burns the original NFT after revoke", async function () {
    const { trustTix, owner, buyer1 } = await loadFixture(deployFixture);
    const avail = await trustTix.getAvailableTickets();
    const tokenId = avail[0];
    await trustTix.connect(buyer1).buyTicket(tokenId, { value: PRICE });
    await trustTix.connect(owner).revokeAndRefund(tokenId);

    await expect(trustTix.ownerOf(tokenId)).to.be.revertedWithCustomError(
      trustTix,
      "ERC721NonexistentToken"
    );
  });

  it("re-pools a new ticket with the same seat number", async function () {
    const { trustTix, owner, buyer1 } = await loadFixture(deployFixture);
    const avail = await trustTix.getAvailableTickets();
    const tokenId = avail[0];
    await trustTix.connect(buyer1).buyTicket(tokenId, { value: PRICE });

    const poolSizeBefore = (await trustTix.getAvailableTickets()).length;
    await trustTix.connect(owner).revokeAndRefund(tokenId);
    const poolAfter = await trustTix.getAvailableTickets();

    expect(poolAfter.length).to.equal(poolSizeBefore + 1);

    // The newly re-pooled ticket should still carry seat 1
    const newTokenId = poolAfter[poolAfter.length - 1];
    const info = await trustTix.getTicketInfo(newTokenId);
    expect(info.seatNumber).to.equal(1n);
    expect(info.status).to.equal(0n); // AVAILABLE
  });

  it("decrements walletTicketCount so buyer can repurchase after revoke", async function () {
    const { trustTix, owner, buyer1 } = await loadFixture(deployFixture);
    const avail = await trustTix.getAvailableTickets();
    await trustTix.connect(buyer1).buyTicket(avail[0], { value: PRICE });
    await trustTix.connect(buyer1).buyTicket(avail[1], { value: PRICE });
    // At limit (2 / 2)

    await trustTix.connect(owner).revokeAndRefund(avail[0]);

    const newPool = await trustTix.getAvailableTickets();
    await expect(
      trustTix.connect(buyer1).buyTicket(newPool[0], { value: PRICE })
    ).to.not.be.reverted;
  });

  it("allows revoking a frozen ticket", async function () {
    const { trustTix, owner, buyer1 } = await loadFixture(deployFixture);
    const avail = await trustTix.getAvailableTickets();
    const tokenId = avail[0];
    await trustTix.connect(buyer1).buyTicket(tokenId, { value: PRICE });
    await trustTix.connect(owner).freezeTicket(tokenId);

    await expect(
      trustTix.connect(owner).revokeAndRefund(tokenId)
    ).to.emit(trustTix, "TicketRevoked");
  });

  it("rejects revokeAndRefund on an AVAILABLE ticket", async function () {
    const { trustTix, owner } = await loadFixture(deployFixture);
    const avail = await trustTix.getAvailableTickets();
    await expect(
      trustTix.connect(owner).revokeAndRefund(avail[0])
    ).to.be.revertedWith("TrustTix: can only revoke SOLD or FROZEN tickets");
  });

  it("rejects revokeAndRefund by non-owner", async function () {
    const { trustTix, buyer1, buyer2 } = await loadFixture(deployFixture);
    const avail = await trustTix.getAvailableTickets();
    await trustTix.connect(buyer1).buyTicket(avail[0], { value: PRICE });
    await expect(
      trustTix.connect(buyer2).revokeAndRefund(avail[0])
    ).to.be.revertedWithCustomError(trustTix, "OwnableUnauthorizedAccount");
  });

  it("updates event counters correctly after revoke", async function () {
    const { trustTix, owner, buyer1 } = await loadFixture(deployFixture);
    const avail = await trustTix.getAvailableTickets();
    await trustTix.connect(buyer1).buyTicket(avail[0], { value: PRICE });
    await trustTix.connect(owner).revokeAndRefund(avail[0]);

    const info = await trustTix.getEventInfo();
    expect(info.ticketsSold).to.equal(0);
    expect(info.ticketsAvailable).to.equal(TOTAL_TICKETS);
  });
});

// ─── markUsed & Gate Entry ────────────────────────────────────────────────────

describe("TrustTix — markUsed & Gate Entry", function () {
  async function withPurchase() {
    const base = await loadFixture(deployFixture);
    const available = await base.trustTix.getAvailableTickets();
    const tokenId = available[0];
    await base.trustTix
      .connect(base.buyer1)
      .buyTicket(tokenId, { value: PRICE });
    return { ...base, tokenId };
  }

  it("allows owner to mark a ticket used and emits TicketUsed", async function () {
    const { trustTix, owner, buyer1, tokenId } = await withPurchase();

    const tx = await trustTix.connect(owner).markUsed(tokenId);
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt.blockNumber);

    await expect(tx)
      .to.emit(trustTix, "TicketUsed")
      .withArgs(tokenId, buyer1.address, BigInt(block.timestamp));

    const info = await trustTix.getTicketInfo(tokenId);
    expect(info.status).to.equal(3n); // USED = 3
  });

  it("allows gate staff (non-owner) to mark a ticket used", async function () {
    const { trustTix, owner, staff, tokenId } = await withPurchase();
    await trustTix.connect(owner).addStaff(staff.address);

    await expect(
      trustTix.connect(staff).markUsed(tokenId)
    ).to.emit(trustTix, "TicketUsed");
  });

  it("prevents reuse — second markUsed on USED ticket fails", async function () {
    const { trustTix, owner, tokenId } = await withPurchase();
    await trustTix.connect(owner).markUsed(tokenId);

    await expect(
      trustTix.connect(owner).markUsed(tokenId)
    ).to.be.revertedWith("TrustTix: ticket must be SOLD to mark used");
  });

  it("blocks transfer of a used ticket", async function () {
    const { trustTix, owner, buyer1, buyer2, tokenId } = await withPurchase();
    await trustTix.connect(owner).markUsed(tokenId);

    await expect(
      trustTix
        .connect(buyer1)
        .transferFrom(buyer1.address, buyer2.address, tokenId)
    ).to.be.revertedWith("TrustTix: used tickets cannot be transferred");
  });

  it("rejects markUsed from non-staff non-owner", async function () {
    const { trustTix, buyer2, tokenId } = await withPurchase();
    await expect(
      trustTix.connect(buyer2).markUsed(tokenId)
    ).to.be.revertedWith("TrustTix: caller is not staff or owner");
  });

  it("revokes staff role — ex-staff cannot markUsed", async function () {
    const { trustTix, owner, staff, tokenId } = await withPurchase();
    await trustTix.connect(owner).addStaff(staff.address);
    await trustTix.connect(owner).removeStaff(staff.address);

    await expect(
      trustTix.connect(staff).markUsed(tokenId)
    ).to.be.revertedWith("TrustTix: caller is not staff or owner");
  });
});
