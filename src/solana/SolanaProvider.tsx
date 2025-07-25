import { AnchorProvider, Wallet } from '@coral-xyz/anchor'
import { AccountFetchCache } from '@helium/account-fetch-cache'
import { AccountContext } from '@helium/account-fetch-cache-hooks'
import { SolanaProvider as SolanaProviderRnHelium } from '@helium/react-native-sdk'
import { DC_MINT, HNT_MINT, chunks } from '@helium/spl-utils'
import { ConnectionContext } from '@solana/wallet-adapter-react'
import {
  AccountInfo,
  Cluster,
  Commitment,
  Connection,
  PublicKey,
  RpcResponseAndContext,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js'
import { signMessageEd25519 } from '@utils/crypto'
import { WrappedConnection } from '@utils/WrappedConnection'
import React, {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from 'react'
import { useAsync } from 'react-async-hook'
import { useSelector } from 'react-redux'
import KeystoneModal, {
  KeystoneModalRef,
} from '../features/keystone/KeystoneModal'
import LedgerModal, { LedgerModalRef } from '../features/ledger/LedgerModal'
import { useAccountStorage } from '../storage/AccountStorageProvider'
import { getSolanaKeypair } from '../storage/secureStorage'
import { RootState } from '../store/rootReducer'
import { appSlice } from '../store/slices/appSlice'
import { useAppDispatch } from '../store/store'
import { getConnection, isVersionedTransaction } from '../utils/solanaUtils'
import { AsyncAccountCache } from './AsyncAccountCache'

const useSolanaHook = () => {
  const { currentAccount } = useAccountStorage()
  const dispatch = useAppDispatch()
  const cluster = useSelector(
    (state: RootState) => state.app.cluster || 'mainnet-beta',
  )
  const ledgerModalRef = useRef<LedgerModalRef>()
  const keystoneModalRef = useRef<KeystoneModalRef>()
  const connection: WrappedConnection | undefined = useMemo(() => {
    return getConnection(cluster)
  }, [cluster])
  const isDevnet = useMemo(() => cluster === 'devnet', [cluster])
  const address = useMemo(
    () => currentAccount?.address,
    [currentAccount?.address],
  )
  const { result: secureAcct } = useAsync(
    async (addr: string | undefined) => {
      if (addr) {
        return getSolanaKeypair(addr)
      }
    },
    [address],
  )

  const signTxn = useCallback(
    async (transaction: Transaction | VersionedTransaction) => {
      // ledger device and keystone device will use cold wallet sign tx
      if (
        (!currentAccount?.ledgerDevice?.id ||
          !currentAccount?.ledgerDevice?.type ||
          currentAccount?.accountIndex === undefined) &&
        !currentAccount?.keystoneDevice
      ) {
        if (!isVersionedTransaction(transaction)) {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          transaction.partialSign(secureAcct!)
          return transaction
        }

        if (!currentAccount?.solanaAddress || !secureAcct?.secretKey)
          return transaction

        transaction.sign([
          {
            publicKey: new PublicKey(currentAccount.solanaAddress),
            secretKey: secureAcct.secretKey,
          },
        ])

        return transaction
      }
      if (currentAccount?.keystoneDevice) {
        const signature = await keystoneModalRef.current?.showKeystoneModal({
          transaction: isVersionedTransaction(transaction)
            ? Buffer.from(transaction.message.serialize())
            : transaction.serializeMessage(),
        })
        if (!signature || signature.length === 0) {
          throw new Error('Transaction is not signed')
        }
        transaction.addSignature(
          new PublicKey(currentAccount.solanaAddress as string),
          signature,
        )
        return transaction
      }

      const signature = await ledgerModalRef?.current?.showLedgerModal({
        transaction: isVersionedTransaction(transaction)
          ? Buffer.from(transaction.message.serialize())
          : transaction.serializeMessage(),
      })

      if (!signature) throw new Error('Transaction not signed')
      transaction.addSignature(
        new PublicKey(currentAccount.solanaAddress || ''),
        signature,
      )

      return transaction
    },
    [currentAccount, secureAcct],
  )

  const signMsg = useCallback(
    async (msg: Buffer) => {
      if (!currentAccount?.solanaAddress) return msg

      if (
        (!currentAccount?.ledgerDevice?.id ||
          !currentAccount?.ledgerDevice?.type ||
          !currentAccount?.accountIndex) &&
        secureAcct?.secretKey
      ) {
        const signer = {
          publicKey: currentAccount?.solanaAddress,
          secretKey: secureAcct.secretKey,
        }

        const signedMessage = await signMessageEd25519(msg, signer.secretKey)
        return Buffer.from(signedMessage)
      }

      const signedMessage = await ledgerModalRef?.current?.showLedgerModal({
        message: msg,
      })

      if (!signedMessage) throw new Error('Message not signed')

      return signedMessage
    },
    [currentAccount, secureAcct],
  )

  const anchorProvider = useMemo(() => {
    if (
      (!secureAcct &&
        !currentAccount?.ledgerDevice &&
        !currentAccount?.solanaAddress &&
        !currentAccount?.keystoneDevice) ||
      !connection
    )
      return

    const anchorWallet = {
      signTransaction: async (
        transaction: Transaction | VersionedTransaction,
      ) => {
        const signedTx = await signTxn(transaction)
        return signedTx
      },
      signAllTransactions: async (
        transactions: (Transaction | VersionedTransaction)[],
      ) => {
        const signedTxns: (Transaction | VersionedTransaction)[] = []
        // eslint-disable-next-line no-restricted-syntax
        for (const transaction of transactions) {
          // eslint-disable-next-line no-await-in-loop
          const signedTx = await signTxn(transaction)
          signedTxns.push(signedTx)
        }

        return signedTxns
      },
      get publicKey() {
        if (currentAccount?.solanaAddress) {
          return new PublicKey(currentAccount?.solanaAddress || '')
        }
      },
    } as Wallet
    return new AnchorProvider(connection, anchorWallet, {
      preflightCommitment: 'confirmed',
      commitment: 'confirmed',
      skipPreflight: true,
    })
  }, [
    connection,
    currentAccount?.solanaAddress,
    currentAccount?.ledgerDevice,
    currentAccount?.keystoneDevice,
    secureAcct,
    signTxn,
  ])

  const { result: cache } = useAsync(async () => {
    if (!connection || !cluster) return

    const asyncCache = new AsyncAccountCache(`accounts-${cluster}`)
    try {
      await asyncCache.init()
    } catch (e) {
      console.error('Failed to init cache', e)
    }
    const c = new AccountFetchCache({
      connection,
      delay: 100,
      commitment: 'confirmed',
      missingRefetchDelay: 60 * 1000,
      extendConnection: true,
      cache: asyncCache,
    })
    // Async fetch the cache accounts to check for changes and update account fetch cache
    ;(async () => {
      const keys = asyncCache.keys().map((k) => new PublicKey(k))
      const nonWrappedConnection = new Connection(connection.rpcEndpoint)
      const accts = (
        await Promise.all(
          chunks(keys, 100).map((k) =>
            nonWrappedConnection.getMultipleAccountsInfo(k),
          ),
        )
      ).flat()
      accts.forEach((acc, index) => {
        const key = keys[index]
        if (acc) {
          if (
            !c.get(key)?.account.data.equals(acc.data) ||
            c.get(key)?.account.lamports !== acc.lamports ||
            !c.get(key)?.account.owner.equals(acc.owner)
          ) {
            c.updateCacheAndRaiseUpdated(key.toBase58(), {
              pubkey: key,
              account: acc,
            })
          }
          // Account existed and now doesn't
        } else if (c.get(key)) {
          c.updateCacheAndRaiseUpdated(key.toBase58(), null)
        }
      })
    })()
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    if (!connection.wrapped) {
      const oldGetAccountinfoAndContext =
        connection.getAccountInfoAndContext.bind(connection)

      // Anchor uses this call on .fetch and .fetchNullable even though it doesn't actually need the context. Add caching.
      connection.getAccountInfoAndContext = async (
        publicKey: PublicKey,
        com?: Commitment,
      ): Promise<RpcResponseAndContext<AccountInfo<Buffer> | null>> => {
        if (
          (com || connection.commitment) === 'confirmed' ||
          typeof (com || connection.commitment) === 'undefined'
        ) {
          const [result, dispose] = await c.searchAndWatch(publicKey)
          setTimeout(dispose, 30 * 1000) // cache for 30s
          return {
            value: result?.account || null,
            context: {
              slot: 0,
            },
          }
        }
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        return oldGetAccountinfoAndContext!(publicKey, com)
      }
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      connection.wrapped = true
    }

    return c
  }, [connection, cluster])
  useEffect(() => {
    // Don't sub to hnt or dc they change a bunch
    cache?.statics.add(HNT_MINT.toBase58())
    cache?.statics.add(DC_MINT.toBase58())

    return () => cache?.close()
  }, [cache])

  const updateCluster = useCallback(
    (nextCluster: Cluster) => {
      dispatch(appSlice.actions.setCluster(nextCluster))
    },
    [dispatch],
  )

  return {
    anchorProvider,
    cluster,
    isDevnet,
    connection: connection as WrappedConnection | undefined,
    updateCluster,
    cache,
    signMsg,
    ledgerModalRef,
    keystoneModalRef,
  }
}

const initialState: {
  anchorProvider: AnchorProvider | undefined
  cluster: Cluster
  isDevnet: boolean
  connection: WrappedConnection | undefined
  cache: AccountFetchCache | undefined
  updateCluster: (nextCluster: Cluster) => void
  signMsg: (msg: Buffer) => Promise<Buffer>
  ledgerModalRef: React.MutableRefObject<LedgerModalRef | undefined>
  keystoneModalRef: React.MutableRefObject<KeystoneModalRef | undefined>
} = {
  anchorProvider: undefined,
  cluster: 'mainnet-beta' as Cluster,
  isDevnet: false,
  connection: undefined,
  cache: undefined,
  updateCluster: (_nextCluster: Cluster) => {},
  signMsg: (_msg: Buffer) => Promise.resolve(_msg),
  ledgerModalRef: { current: undefined },
  keystoneModalRef: { current: undefined },
}
const SolanaContext =
  createContext<ReturnType<typeof useSolanaHook>>(initialState)

const SolanaProvider = ({ children }: { children: ReactNode }) => {
  const values = useSolanaHook()
  return (
    <SolanaContext.Provider value={values}>
      {values.cache && values.connection && (
        <ConnectionContext.Provider value={{ connection: values.connection }}>
          <AccountContext.Provider value={values.cache}>
            <SolanaProviderRnHelium
              connection={values.connection}
              cluster={values.cluster}
            >
              <KeystoneModal ref={values?.keystoneModalRef}>
                <LedgerModal ref={values?.ledgerModalRef}>
                  {children}
                </LedgerModal>
              </KeystoneModal>
            </SolanaProviderRnHelium>
          </AccountContext.Provider>
        </ConnectionContext.Provider>
      )}
    </SolanaContext.Provider>
  )
}

export const useSolana = (): SolanaManager => useContext(SolanaContext)

export default SolanaProvider

export type SolanaManager = ReturnType<typeof useSolanaHook>
