/**
 * simulate-normal-buyers.js
 *
 * Sends real on-chain transactions from several distinct Hardhat accounts,
 * each buying 1–2 tickets with realistic gaps between purchases.
 *
 * These transactions will appear in the backend's live event feed and score
 * as LOW RISK — no shared funding source, purchases spread over time.
 *
 * Usage (against a running `npx hardhat node`):
 *   npx hardhat run scripts/simulate-normal-buyers.js --network localhost
 */

const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");

// ── helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function loadDeployment() {
  const deployPath = path.join(__dirname, "../deployment.json");
  if (!fs.existsSync(deployPath)) {
    throw new Error(
      "deployment.json not found. Run deploy.js first:\n" +
        "  npx hardhat run scripts/deploy.js --network localhost"
    );
  }
  return JSON.parse(fs.readFileSync(deployPath, "utf8"));
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const deployment = await loadDeployment();
  const signers = await ethers.getSigners();

  // Use accounts 2–7 as normal buyers (account 0 = deployer/organizer,
  // account 1 reserved for the scalper simulation source wallet)
  const normalBuyers = signers.slice(2, 8);

  console.log("\n=== Normal Buyer Simulation ===");
  console.log("Contract :", deployment.contractAddress);
  console.log("Buyers   :", normalBuyers.length, "wallets\n");

  const TrustTix = await ethers.getContractFactory("TrustTix");
  const trustTix = TrustTix.attach(deployment.contractAddress);

  // Each buyer picks 1 or 2 tickets from the current available pool
  for (let i = 0; i < normalBuyers.length; i++) {
    const buyer = normalBuyers[i];
    const ticketsToBuy = i < 3 ? 1 : 2; // first 3 buy 1; rest buy 2

    const available = await trustTix.getAvailableTickets();
    if (available.length === 0) {
      console.log("No more tickets available — stopping early.");
      break;
    }

    console.log(
      `Buyer ${i + 1} (${buyer.address.slice(0, 10)}…) — buying ${ticketsToBuy} ticket(s)`
    );

    for (let t = 0; t < ticketsToBuy; t++) {
      const pool = await trustTix.getAvailableTickets();
      if (pool.length === 0) break;

      // Pick the first available tokenId each time
      const tokenId = pool[0];

      const tx = await trustTix
        .connect(buyer)
        .buyTicket(tokenId, { value: ethers.parseEther("0.01") });
      const receipt = await tx.wait();

      console.log(
        `  ✓ Bought tokenId ${tokenId} (tx: ${receipt.hash.slice(0, 18)}…)`
      );

      // Realistic pause between individual purchases: 2–6 seconds
      if (t < ticketsToBuy - 1) {
        await sleep(randomBetween(2000, 6000));
      }
    }

    // Realistic gap between different buyers: 3–8 seconds
    if (i < normalBuyers.length - 1) {
      const gap = randomBetween(3000, 8000);
      console.log(`  (waiting ${(gap / 1000).toFixed(1)}s before next buyer…)`);
      await sleep(gap);
    }
  }

  const info = await trustTix.getEventInfo();
  console.log("\n=== Summary ===");
  console.log("Tickets sold    :", info.ticketsSold.toString());
  console.log("Tickets remaining:", info.ticketsAvailable.toString());
  console.log("Normal simulation complete.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
