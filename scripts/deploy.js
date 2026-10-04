/**
 * deploy.js
 *
 * Deploys TrustTix to the configured network and creates the demo event:
 *   - 30 tickets
 *   - 0.01 ETH per ticket
 *   - max 2 tickets per wallet
 *
 * Usage:
 *   npx hardhat run scripts/deploy.js --network localhost
 *   npx hardhat run scripts/deploy.js --network sepolia
 *
 * After running, copy the printed contract address into your .env file as
 * CONTRACT_ADDRESS so the backend and simulation scripts can find it.
 */

const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("\n=== TrustTix Deployment ===");
  console.log("Network  :", hre.network.name);
  console.log("Deployer :", deployer.address);
  console.log(
    "Balance  :",
    ethers.formatEther(await ethers.provider.getBalance(deployer.address)),
    "ETH\n"
  );

  // ── Deploy contract ───────────────────────────────────────────────────────
  console.log("Deploying TrustTix...");
  const TrustTix = await ethers.getContractFactory("TrustTix");
  const trustTix = await TrustTix.deploy();
  await trustTix.waitForDeployment();
  const contractAddress = await trustTix.getAddress();
  console.log("✓ TrustTix deployed to:", contractAddress);

  // ── Create event ─────────────────────────────────────────────────────────
  const TOTAL_TICKETS = 30;
  const PRICE_WEI = ethers.parseEther("0.01");
  const MAX_PER_WALLET = 2;
  const EVENT_NAME = "TrustTix Demo Concert 2026";

  console.log("\nCreating event...");
  console.log("  Name         :", EVENT_NAME);
  console.log("  Tickets      :", TOTAL_TICKETS);
  console.log("  Price        : 0.01 ETH");
  console.log("  Max / wallet :", MAX_PER_WALLET);

  const tx = await trustTix.createEvent(
    EVENT_NAME,
    TOTAL_TICKETS,
    PRICE_WEI,
    MAX_PER_WALLET
  );
  const receipt = await tx.wait();
  console.log("✓ Event created (tx:", receipt.hash, ")");

  // Verify pool size
  const pool = await trustTix.getAvailableTickets();
  console.log("✓ Available tickets in pool:", pool.length);

  // ── Save deployment info ──────────────────────────────────────────────────
  // Write a deployment.json that the backend + simulation scripts read.
  const deploymentInfo = {
    network: hre.network.name,
    contractAddress,
    deployerAddress: deployer.address,
    deployedAt: new Date().toISOString(),
    event: {
      name: EVENT_NAME,
      totalTickets: TOTAL_TICKETS,
      priceInWei: PRICE_WEI.toString(),
      maxPerWallet: MAX_PER_WALLET,
    },
  };

  const deploymentPath = path.join(__dirname, "../deployment.json");
  fs.writeFileSync(deploymentPath, JSON.stringify(deploymentInfo, null, 2));
  console.log("\n✓ Deployment info saved to deployment.json");

  // Also copy the ABI into server/ for easy import by the backend
  const artifactPath = path.join(
    __dirname,
    "../artifacts/contracts/TrustTix.sol/TrustTix.json"
  );
  if (fs.existsSync(artifactPath)) {
    const serverDir = path.join(__dirname, "../server");
    if (!fs.existsSync(serverDir)) fs.mkdirSync(serverDir, { recursive: true });
    fs.copyFileSync(artifactPath, path.join(serverDir, "TrustTix.json"));
    console.log("✓ ABI copied to server/TrustTix.json");
  }

  console.log("\n=== Next steps ===");
  console.log(
    "1. Add to your .env:\n   CONTRACT_ADDRESS=" + contractAddress
  );
  console.log(
    "2. Add ORGANIZER_PRIVATE_KEY=<deployer-private-key> to .env"
  );
  console.log("3. Start the backend: cd server && npm start");
  console.log("4. Start the frontend: cd client && npm run dev\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
