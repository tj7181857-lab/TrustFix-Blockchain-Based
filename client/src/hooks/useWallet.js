/**
 * useWallet.js
 *
 * MetaMask connection hook.
 * Returns { account, provider, signer, chainId, connect, disconnect, error, isConnecting }
 *
 * Works with Ethers.js v6's BrowserProvider.
 */

import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import { HARDHAT_CHAIN_ID } from "../contractConfig";

export function useWallet() {
  const [account, setAccount] = useState(null);
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [error, setError] = useState(null);
  const [isConnecting, setIsConnecting] = useState(false);

  // ── Connect ─────────────────────────────────────────────────────────────
  const connect = useCallback(async () => {
    if (!window.ethereum) {
      setError("MetaMask is not installed. Please install it from metamask.io");
      return;
    }

    setIsConnecting(true);
    setError(null);

    try {
      const browserProvider = new ethers.BrowserProvider(window.ethereum);

      // Request account access
      await browserProvider.send("eth_requestAccounts", []);

      const network = await browserProvider.getNetwork();
      const signerInstance = await browserProvider.getSigner();
      const address = await signerInstance.getAddress();

      setProvider(browserProvider);
      setSigner(signerInstance);
      setAccount(address);
      setChainId(Number(network.chainId));
    } catch (err) {
      if (err.code === 4001) {
        setError("Connection rejected. Please approve in MetaMask.");
      } else {
        setError(err.message);
      }
    } finally {
      setIsConnecting(false);
    }
  }, []);

  // ── Disconnect ───────────────────────────────────────────────────────────
  const disconnect = useCallback(() => {
    setAccount(null);
    setProvider(null);
    setSigner(null);
    setChainId(null);
  }, []);

  // ── Listen for account / chain changes ──────────────────────────────────
  useEffect(() => {
    if (!window.ethereum) return;

    const handleAccountsChanged = async (accounts) => {
      if (accounts.length === 0) {
        disconnect();
      } else {
        setAccount(accounts[0]);
        if (provider) {
          const newSigner = await provider.getSigner();
          setSigner(newSigner);
        }
      }
    };

    const handleChainChanged = (chainIdHex) => {
      setChainId(parseInt(chainIdHex, 16));
      // Reload to avoid stale provider state
      window.location.reload();
    };

    window.ethereum.on("accountsChanged", handleAccountsChanged);
    window.ethereum.on("chainChanged", handleChainChanged);

    return () => {
      window.ethereum.removeListener("accountsChanged", handleAccountsChanged);
      window.ethereum.removeListener("chainChanged", handleChainChanged);
    };
  }, [provider, disconnect]);

  // ── Helper: is the user on the right network? ────────────────────────────
  const isCorrectNetwork = chainId === HARDHAT_CHAIN_ID;

  const addHardhatNetwork = useCallback(async () => {
    try {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: "0x7A69", // 31337 in hex
            chainName: "Hardhat Local",
            nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
            rpcUrls: ["http://127.0.0.1:8545"],
          },
        ],
      });
    } catch (err) {
      setError(err.message);
    }
  }, []);

  return {
    account,
    provider,
    signer,
    chainId,
    isCorrectNetwork,
    isConnecting,
    error,
    connect,
    disconnect,
    addHardhatNetwork,
  };
}
