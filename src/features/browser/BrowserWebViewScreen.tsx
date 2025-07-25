import BackArrow from '@assets/images/backArrow.svg'
import Bookmark from '@assets/images/bookmark.svg'
import BookmarkFilled from '@assets/images/bookmarkFilled.svg'
import Close from '@assets/images/close.svg'
import Refresh from '@assets/images/refresh.svg'
import { RouteProp, useNavigation, useRoute } from '@react-navigation/native'
import {
  SolanaSignAndSendTransactionInput,
  SolanaSignMessageInput,
} from '@solana/wallet-standard-features'
import { Transaction, VersionedTransaction } from '@solana/web3.js'
import { useSpacing } from '@theme/themeHooks'
import bs58 from 'bs58'
import React, { useCallback, useMemo, useRef, useState } from 'react'
import { Platform, StyleSheet } from 'react-native'
import { Edge } from 'react-native-safe-area-context'
import {
  WebView,
  WebViewMessageEvent,
  WebViewNavigation,
} from 'react-native-webview'
import Box from '../../components/Box'
import SafeAreaBox from '../../components/SafeAreaBox'
import Text from '../../components/Text'
import TouchableOpacityBox from '../../components/TouchableOpacityBox'
import useBrowser from '../../hooks/useBrowser'
import SolanaProvider, { useSolana } from '../../solana/SolanaProvider'
import WalletSignBottomSheet from '../../solana/WalletSignBottomSheet'
import {
  WalletSignBottomSheetRef,
  WalletStandardMessageTypes,
} from '../../solana/walletSignBottomSheetTypes'
import { useAccountStorage } from '../../storage/AccountStorageProvider'
import * as Logger from '../../utils/logger'
import { BrowserNavigationProp, BrowserStackParamList } from './browserTypes'
import injectWalletStandard from './walletStandard'

type Route = RouteProp<BrowserStackParamList, 'BrowserWebViewScreen'>

export const BrowserWrapper = () => {
  return (
    <Box flex={1}>
      <SolanaProvider>
        <BrowserWebViewScreen />
      </SolanaProvider>
    </Box>
  )
}

const BrowserWebViewScreen = () => {
  const route = useRoute<Route>()
  const { uri } = route.params
  const edges = useMemo(() => ['top'] as Edge[], [])
  const { currentAccount } = useAccountStorage()
  const { anchorProvider, signMsg } = useSolana()
  const webview = useRef<WebView | null>(null)
  const walletSignBottomSheetRef = useRef<WalletSignBottomSheetRef | null>(null)

  const [currentUrl, setCurrentUrl] = useState(uri)
  const accountAddress = useMemo(
    () => currentAccount?.solanaAddress,
    [currentAccount?.solanaAddress],
  )

  const navigation = useNavigation<BrowserNavigationProp>()
  const { favorites, addFavorite, removeFavorite } = useBrowser()
  const isAndroid = useMemo(() => Platform.OS === 'android', [])
  const spacing = useSpacing()
  const [isScriptInjected, setIsScriptInjected] = useState(false)

  const isFavorite = useMemo(() => {
    return favorites.some((favorite) => favorite === currentUrl)
  }, [favorites, currentUrl])

  const onMessage = useCallback(
    async (msg: WebViewMessageEvent) => {
      if (
        !currentAccount?.address ||
        !currentAccount?.solanaAddress ||
        !anchorProvider ||
        !walletSignBottomSheetRef
      ) {
        return
      }

      const { data } = msg.nativeEvent

      const { type, inputs } = JSON.parse(data)

      if (type === WalletStandardMessageTypes.connect) {
        Logger.breadcrumb('connect')
        const decision = await walletSignBottomSheetRef.current?.show({
          type,
          url: currentUrl,
          serializedTxs: undefined,
        })

        if (!decision) {
          // Signature declined
          webview.current?.postMessage(
            JSON.stringify({
              type: 'connectDeclined',
            }),
          )
          return
        }

        webview.current?.postMessage(
          JSON.stringify({
            type: 'connectApproved',
          }),
        )
      } else if (type === WalletStandardMessageTypes.signAndSendTransaction) {
        Logger.breadcrumb('signAndSendTransaction')
        const decision = await walletSignBottomSheetRef?.current?.show({
          type,
          url: currentUrl,
          serializedTxs: undefined,
        })

        if (!decision) {
          // Signature declined
          webview.current?.postMessage(
            JSON.stringify({
              type: 'signatureDeclined',
            }),
          )
          return
        }

        let isVersionedTransaction = false

        // Converting int array objects to Uint8Array
        const transactions = await Promise.all(
          inputs.map(
            async ({
              transaction,
              chain,
              options,
            }: SolanaSignAndSendTransactionInput) => {
              const tx = new Uint8Array(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                Object.keys(transaction).map((k) => (transaction as any)[k]),
              )
              try {
                const versionedTx = VersionedTransaction.deserialize(tx)
                isVersionedTransaction = !!versionedTx
              } catch (e) {
                isVersionedTransaction = false
              }

              return {
                transaction: isVersionedTransaction
                  ? VersionedTransaction.deserialize(tx)
                  : Transaction.from(tx),
                chain,
                options,
              }
            },
          ),
        )

        const signatures = await Promise.all(
          transactions.map(
            async ({
              transaction,
              options,
            }: SolanaSignAndSendTransactionInput & {
              transaction: Transaction | VersionedTransaction
            }) => {
              let signedTransaction:
                | Transaction
                | VersionedTransaction
                | undefined
              if (!isVersionedTransaction) {
                // TODO: Verify when lookup table is needed
                // transaction.add(lookupTableAddress)
                signedTransaction =
                  await anchorProvider?.wallet.signTransaction(
                    transaction as Transaction,
                  )
              } else {
                signedTransaction =
                  await anchorProvider?.wallet.signTransaction(
                    transaction as VersionedTransaction,
                  )
              }

              if (!signedTransaction) {
                throw new Error('Failed to sign transaction')
              }

              const conn = anchorProvider.connection

              const signature = await conn.sendRawTransaction(
                signedTransaction.serialize(),
                {
                  skipPreflight: true,
                  maxRetries: 5,
                  ...options,
                },
              )

              // Return signature as int8array
              return { signature: bs58.decode(signature) }
            },
          ),
        )
        webview.current?.postMessage(
          JSON.stringify({
            type: 'transactionSigned',
            data: signatures,
          }),
        )
      } else if (type === WalletStandardMessageTypes.signTransaction) {
        Logger.breadcrumb('signTransaction')
        const outputs: { signedTransaction: Uint8Array }[] = []

        let isVersionedTransaction = false

        // Converting int array objects to Uint8Array
        const transactions = await Promise.all(
          inputs.map(
            async ({
              transaction,
              chain,
              options,
            }: SolanaSignAndSendTransactionInput) => {
              const tx = new Uint8Array(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                Object.keys(transaction).map((k) => (transaction as any)[k]),
              )
              try {
                const versionedTx = VersionedTransaction.deserialize(tx)
                isVersionedTransaction = !!versionedTx
              } catch (e) {
                isVersionedTransaction = false
              }

              return {
                transaction: isVersionedTransaction
                  ? VersionedTransaction.deserialize(tx)
                  : Transaction.from(tx),
                chain,
                options,
              }
            },
          ),
        )

        const txBuffers: Buffer[] = inputs.map(
          ({ transaction }: SolanaSignAndSendTransactionInput) =>
            new Uint8Array(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              Object.keys(transaction).map((k) => (transaction as any)[k]),
            ),
        )

        const decision = await walletSignBottomSheetRef.current?.show({
          type,
          url: currentUrl,
          serializedTxs: txBuffers,
        })
        if (!decision) {
          // Signature declined
          webview.current?.postMessage(
            JSON.stringify({
              type: 'signatureDeclined',
            }),
          )
          return
        }

        const signedTransactions: (Transaction | VersionedTransaction)[] = []
        // eslint-disable-next-line no-restricted-syntax
        for (const txInput of transactions) {
          try {
            const { transaction } = txInput
            const convertTx = isVersionedTransaction
              ? (transaction as VersionedTransaction)
              : (transaction as Transaction)
            const signedTransaction =
              await anchorProvider?.wallet.signTransaction(convertTx)
            signedTransactions.push(signedTransaction)
          } catch (e) {
            throw new Error('Failed to sign transaction')
          }
        }

        outputs.push(
          ...signedTransactions.map((signedTransaction) => {
            return {
              signedTransaction: new Uint8Array(signedTransaction.serialize()),
            }
          }),
        )

        webview.current?.postMessage(
          JSON.stringify({
            type: 'transactionSigned',
            data: outputs,
          }),
        )
      } else if (type === WalletStandardMessageTypes.signMessage) {
        Logger.breadcrumb('signMessage')
        const decision = await walletSignBottomSheetRef.current?.show({
          type,
          url: currentUrl,
          message: inputs
            .map(({ message }: SolanaSignMessageInput) =>
              Buffer.from(message).toString('utf-8'),
            )
            .join(','),
          serializedTxs: undefined,
        })

        if (!decision) {
          // Signature declined
          webview.current?.postMessage(
            JSON.stringify({
              type: 'signatureDeclined',
            }),
          )
          return
        }

        // Converting int array objects to Uint8Array
        const messages: Buffer[] = inputs.map(
          ({ message }: SolanaSignMessageInput) => {
            return Buffer.from(message)
          },
        )

        // Sign each message using nacl and return the signature
        const signedMessages = await Promise.all(
          messages.map(async (message) => {
            const signature = await signMsg(message)
            return {
              signedMessage: message.toJSON().data,
              signature: signature.toJSON().data,
            }
          }),
        )

        webview.current?.postMessage(
          JSON.stringify({
            type: 'messageSigned',
            data: signedMessages,
          }),
        )
      } else {
        Logger.breadcrumb('Unknown type', type)
      }
    },
    [
      anchorProvider,
      currentAccount?.address,
      currentAccount?.solanaAddress,
      currentUrl,
      signMsg,
    ],
  )

  const injectedJavascript = useCallback(() => {
    if (isScriptInjected) return ''

    const script = `
    ${injectWalletStandard.toString()}

    // noinspection JSIgnoredPromiseFromCall
    injectWalletStandard("${accountAddress}", [${
      accountAddress && bs58.decode(accountAddress)
    }], ${isAndroid});
    true;
    `

    return script
  }, [accountAddress, isAndroid, isScriptInjected])

  const injectModule = useCallback(() => {
    if (!webview?.current || isScriptInjected) return
    setIsScriptInjected(true)

    const injectionScript = `
      (function() {
        function injectWhenReady() {
          ${injectedJavascript()}
        }

        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', injectWhenReady);
        } else {
          injectWhenReady();
        }
      })();
    `

    webview.current.injectJavaScript(injectionScript)
  }, [injectedJavascript, isScriptInjected])

  const onLoadStart = useCallback(() => {
    setIsScriptInjected(false)
  }, [])

  const onLoadEnd = useCallback(() => {
    if (!isScriptInjected) {
      injectModule()
    }
  }, [isScriptInjected, injectModule])

  const onRefresh = useCallback(() => {
    setIsScriptInjected(false)
    webview.current?.reload()
  }, [])

  const onNavigationChange = useCallback((event: WebViewNavigation) => {
    const baseUrl = event.url.replace('https://', '').split('/')
    setCurrentUrl(baseUrl[0])
  }, [])

  const closeModal = useCallback(() => {
    navigation.goBack()
  }, [navigation])

  const BrowserHeader = useCallback(() => {
    return (
      <Box
        backgroundColor="black900"
        paddingBottom="m"
        paddingStart="m"
        flexDirection="row"
        alignItems="center"
        justifyContent="center"
      >
        <Box width={14 + spacing.m} height={14} />
        <Box flex={1}>
          <Text
            textAlign="center"
            variant="body2Medium"
            color="secondaryText"
            adjustsFontSizeToFit
          >
            {currentUrl}
          </Text>
        </Box>
        <TouchableOpacityBox onPress={closeModal} paddingHorizontal="m">
          <Close color="white" width={14} height={14} />
        </TouchableOpacityBox>
      </Box>
    )
  }, [currentUrl, closeModal, spacing])

  const onBack = useCallback(() => {
    webview.current?.goBack()
  }, [])

  const onForward = useCallback(() => {
    webview.current?.goForward()
  }, [])

  const onFavorite = useCallback(() => {
    if (isFavorite) {
      removeFavorite(currentUrl)
    } else {
      addFavorite(currentUrl)
    }
  }, [addFavorite, removeFavorite, isFavorite, currentUrl])

  const BrowserFooter = useCallback(() => {
    return (
      <Box padding="m" flexDirection="row" backgroundColor="black900">
        <Box flexGrow={1} alignItems="center">
          <TouchableOpacityBox onPress={onBack}>
            <BackArrow width={20} height={20} />
          </TouchableOpacityBox>
        </Box>
        <Box flexGrow={1} alignItems="center">
          <TouchableOpacityBox style={styles.rotatedArrow} onPress={onForward}>
            <BackArrow width={20} height={20} />
          </TouchableOpacityBox>
        </Box>
        <Box flexGrow={1} alignItems="center">
          <TouchableOpacityBox onPress={onFavorite}>
            {isFavorite ? (
              <BookmarkFilled color="white" width={20} height={20} />
            ) : (
              <Bookmark color="white" width={20} height={20} />
            )}
          </TouchableOpacityBox>
        </Box>
        <Box flexGrow={1} alignItems="center">
          <TouchableOpacityBox onPress={onRefresh}>
            <Refresh width={20} height={20} />
          </TouchableOpacityBox>
        </Box>
      </Box>
    )
  }, [onBack, onForward, isFavorite, onFavorite, onRefresh])

  return (
    <SafeAreaBox flex={1} edges={edges} backgroundColor="black900">
      <WalletSignBottomSheet ref={walletSignBottomSheetRef} onClose={() => {}}>
        <BrowserHeader />
        <WebView
          ref={webview}
          originWhitelist={['*']}
          javaScriptEnabled
          onLoadStart={onLoadStart}
          injectedJavaScriptBeforeContentLoaded={injectedJavascript()}
          onLoadEnd={isAndroid ? undefined : onLoadEnd}
          onNavigationStateChange={onNavigationChange}
          onMessage={onMessage}
          source={{ uri }}
          onShouldStartLoadWithRequest={(event) => {
            // Sites should not do this, but if you click MWA on realms it bricks us
            return !event.url.startsWith('solana-wallet:')
          }}
        />
        <BrowserFooter />
      </WalletSignBottomSheet>
    </SafeAreaBox>
  )
}

export default BrowserWebViewScreen

const styles = StyleSheet.create({
  rotatedArrow: {
    transform: [{ rotate: '180deg' }],
  },
})
