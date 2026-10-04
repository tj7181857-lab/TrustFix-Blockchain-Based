/**
 * contractConfig.js
 *
 * Single source of truth for the contract address + ABI used by the frontend.
 * The ABI is imported directly from the Hardhat artifact so it stays in sync
 * with the compiled contract without any manual copy-paste.
 *
 * deployment-multi-event.json is the deployment source of truth.
 */

// Import the compiled artifact — Vite resolves this via the root-level path.
// The artifact is written by `npx hardhat compile` into artifacts/.
import artifact from "../../artifacts/contracts/TrustTixMultiEvent.sol/TrustTixMultiEvent.json";
import deployment from "../../deployment-multi-event.json";

export const CONTRACT_ADDRESS =
  import.meta.env.VITE_MULTI_EVENT_CONTRACT_ADDRESS || deployment.contractAddress;

export const CONTRACT_ABI = artifact.abi;

// Hardhat local network chain ID
export const HARDHAT_CHAIN_ID = 31337;

// Ticket status codes match the enum in TrustTixMultiEvent.sol
export const TicketStatus = {
  0: "AVAILABLE",
  1: "SOLD",
  2: "FROZEN",
  3: "USED",
  AVAILABLE: 0,
  SOLD: 1,
  FROZEN: 2,
  USED: 3,
};

// Backend API base URL
export const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3001";
