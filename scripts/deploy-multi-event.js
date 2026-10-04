/**
 * Deploys the new multi-event TrustTix contract without modifying the legacy
 * single-event deployment or creating demo events/purchase history.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-multi-event.js --network localhost
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();

  console.log("\n=== TrustTix Multi-Event Deployment ===");
  console.log("Network  :", hre.network.name);
  console.log("Chain ID :", network.chainId.toString());
  console.log("Deployer :", deployer.address);

  const artifactPath = path.join(
    __dirname,
    "../artifacts/contracts/TrustTixMultiEvent.sol/TrustTixMultiEvent.json"
  );
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Compiled artifact not found: ${artifactPath}`);
  }

  const TrustTixMultiEvent = await hre.ethers.getContractFactory(
    "TrustTixMultiEvent"
  );
  const contract = await TrustTixMultiEvent.deploy();
  await contract.waitForDeployment();
  const contractAddress = await contract.getAddress();
  const deploymentReceipt = await contract.deploymentTransaction().wait();

  const deploymentInfo = {
    contractName: "TrustTixMultiEvent",
    contractAddress,
    network: hre.network.name,
    chainId: Number(network.chainId),
    deployerAddress: deployer.address,
    deployedAt: new Date().toISOString(),
    deploymentBlock: deploymentReceipt.blockNumber,
    legacyDeployment: "deployment.json",
    initialEventCount: Number(await contract.getEventCount()),
  };

  const serverAbiPath = path.join(
    __dirname,
    "../server/TrustTixMultiEvent.json"
  );
  fs.copyFileSync(artifactPath, serverAbiPath);

  const deploymentPath = path.join(
    __dirname,
    "../deployment-multi-event.json"
  );
  fs.writeFileSync(deploymentPath, JSON.stringify(deploymentInfo, null, 2));

  console.log("\nTrustTix Multi-Event Contract:");
  console.log(contractAddress);
  console.log("\nNetwork:", hre.network.name);
  console.log("Chain ID:", network.chainId.toString());
  console.log("Events created:", deploymentInfo.initialEventCount);
  console.log("Deployment record: deployment-multi-event.json");
  console.log("Backend ABI: server/TrustTixMultiEvent.json");
  console.log("No demo event or purchase history was created.\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
