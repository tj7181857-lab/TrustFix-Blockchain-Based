/**
 * simulate-scalper-attack.js
 *
 * Demonstrates a real scalper cluster on-chain so the detection dashboard
 * can catch it live:
 *
 *   Step 1 — Fund fresh wallets.
 *     A single "source" wallet (accounts[1]) sends ETH to 9 brand-new
 *     wallets that were created just for this simulation. This creates the
 *     "shared funding source" signal the detection service looks for.
 *
 *   Step 2 — Rapid coordinated buying.
 *     All 9 funded wallets buy their maximum allowed tickets (2 each) within
 *     a very short window (< 3 seconds apart), triggering the "burst purchase
 *     timing" signal.
 *
 *   Step 3 — Results.
 *     The backend should detect the shared funding source + timing cluster
 *     and assign a high risk score (≥ 70) to these wallets within seconds.
 *
 * Usage (against a running `npx hardhat node`):
 *   npx hardhat run scripts/simulate-scalper-attack.js --network localhost
 *
 * Note: Run AFTER simulate-normal-buyers.js (or at least after deploy.js)
 *       so the contract already has tickets in the pool.
 */

const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");

// ── helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  // accounts[1] is the scalper's "source" wallet that funds all fake buyers.
  // We use a pre-funded Hardhat account so it already has ETH.
  const sourceWallet = signers[1];

  // Number of fake scalper wallets to fund and deploy
  const SCALPER_COUNT = 9;
  const TICKET_PRICE = ethers.parseEther("0.01");
  const MAX_PER_WALLET = 2;
  // Each scalper wallet needs: (MAX_PER_WALLET * price) + gas buffer
  const FUND_AMOUNT = ethers.parseEther("0.05"); // 0.02 tickets + gas buffer

  console.log("\n=== Scalper Attack Simulation ===");
  console.log("Contract       :", deployment.contractAddress);
  console.log("Source wallet  :", sourceWallet.address);
  console.log("Scalper wallets:", SCALPER_COUNT);
  console.log(
    "Tickets target :",
    SCALPER_COUNT * MAX_PER_WALLET,
    "tickets\n"
  );

  // Check source wallet balance
  const sourceBal = await ethers.provider.getBalance(sourceWallet.address);
  console.log(
    "Source balance :",
    ethers.formatEther(sourceBal),
    "ETH"
  );

  const TrustTix = await ethers.getContractFactory("TrustTix");
  const trustTix = TrustTix.attach(deployment.contractAddress);

  // ── Step 1: Create and fund fresh wallets ───────────────────────────────
  console.log("\n--- Step 1: Funding fresh wallets from source ---");

  const scalperWallets = [];
  const provider = ethers.provider;

  for (let i = 0; i < SCALPER_COUNT; i++) {
    // Generate a brand-new random wallet (zero on-chain history)
    const wallet = ethers.Wallet.createRandom().connect(provider);
    scalperWallets.push(wallet);

    // Fund it from the source wallet — this is the key signal:
    // all these wallets' first-ever ETH comes from the same source.
    const fundTx = await sourceWallet.sendTransaction({
      to: wallet.address,
      value: FUND_AMOUNT,
    });
    await fundTx.wait();

    console.log(
      `  ✓ Funded scalper ${i + 1}: ${wallet.address.slice(0, 14)}… ` +
        `(tx: ${fundTx.hash.slice(0, 18)}…)`
    );
  }

  console.log("\nAll scalper wallets funded. Waiting 2s before burst…\n");
  await sleep(2000);

  // ── Step 2: Rapid coordinated purchases ─────────────────────────────────
  console.log("--- Step 2: Rapid burst buying ---");
  console.log(
    "All wallets will buy their maximum tickets within seconds of each other.\n"
  );

  // Build all purchase promises but stagger them by only 200–500ms to simulate
  // near-simultaneous submissions (like a bot script would do)
  const purchaseResults = [];

  for (let i = 0; i < scalperWallets.length; i++) {
    const scalper = scalperWallets[i];

    // Slight stagger so transactions don't all land in the same block
    // (200-400ms apart simulates concurrent bot requests)
    await sleep(200 + Math.floor(Math.random() * 200));

    // Get fresh pool each iteration
    const pool = await trustTix.getAvailableTickets();
    if (pool.length < MAX_PER_WALLET) {
      console.log(
        `  ! Not enough tickets left for scalper ${i + 1}, skipping.`
      );
      continue;
    }

    const ticketsBought = [];

    // Buy max tickets per wallet
    for (let t = 0; t < MAX_PER_WALLET; t++) {
      const freshPool = await trustTix.getAvailableTickets();
      if (freshPool.length === 0) break;

      const tokenId = freshPool[0];
      try {
        const tx = await trustTix
          .connect(scalper)
          .buyTicket(tokenId, { value: TICKET_PRICE });
        const receipt = await tx.wait();
        ticketsBought.push({ tokenId, txHash: receipt.hash });
        console.log(
          `  ✓ Scalper ${i + 1} bought tokenId ${tokenId}  ` +
            `(tx: ${receipt.hash.slice(0, 18)}…)`
        );
      } catch (err) {
        console.log(`  ✗ Scalper ${i + 1} ticket ${t + 1} failed: ${err.message}`);
      }
    }

    purchaseResults.push({
      wallet: scalper.address,
      tickets: ticketsBought,
    });
  }

  // ── Step 3: Summary ──────────────────────────────────────────────────────
  const totalBought = purchaseResults.reduce(
    (acc, r) => acc + r.tickets.length,
    0
  );

  console.log("\n=== Attack Summary ===");
  console.log(
    `Source wallet    : ${sourceWallet.address}`
  );
  console.log(`Scalper wallets  : ${purchaseResults.length}`);
  console.log(`Total tickets    : ${totalBought}`);
  console.log(
    "\nThe detection service should now show:"
  );
  console.log(
    "  • A cluster of",
    purchaseResults.length,
    "wallets all funded by the same source"
  );
  console.log(
    "  • All purchases within a ~" +
      (purchaseResults.length * 0.4).toFixed(0) +
      "s window"
  );
  console.log(
    "  • All wallets first-active within the last few minutes (new wallet signal)"
  );
  console.log(
    "  • Expected risk score: 70–100 for cluster members\n"
  );

  // Save scalper wallet addresses for the backend to cross-reference
  const scalperInfo = {
    simulatedAt: new Date().toISOString(),
    sourceWallet: sourceWallet.address,
    scalperWallets: purchaseResults.map((r) => r.wallet),
    totalTicketsBought: totalBought,
  };
  fs.writeFileSync(
    path.join(__dirname, "../scalper-simulation.json"),
    JSON.stringify(scalperInfo, null, 2)
  );
  console.log("Scalper info saved to scalper-simulation.json\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
