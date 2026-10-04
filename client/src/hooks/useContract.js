/**
 * useContract.js
 *
 * Returns a read-only and a write-capable (signer-connected) contract instance.
 * Uses ethers v6's Contract class.
 */

import { useMemo } from "react";
import { ethers } from "ethers";
import { CONTRACT_ADDRESS, CONTRACT_ABI } from "../contractConfig";

export function useContract(providerOrSigner) {
  return useMemo(() => {
    if (!providerOrSigner) return null;
    return new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, providerOrSigner);
  }, [providerOrSigner]);
}
