declare module 'tronweb' {
  interface TronWebOptions {
    fullHost?: string
    headers?: Record<string, string>
    privateKey?: string
  }

  interface TransactionResult {
    txid: string
    result: boolean
    transaction: any
  }

  interface ContractResult {
    result: {
      result: boolean
    }
    transaction: any
  }

  class TronWeb {
    constructor(options: TronWebOptions)
    constructor(fullHost: string, solidityNode?: string, eventServer?: string, privateKey?: string)
    
    static providers: {
      HttpProvider: new (host: string, timeout?: number, user?: string, password?: string, headers?: Record<string, string>) => any
    }

    setAddress(address: string): void
    setPrivateKey(privateKey: string): void
    setHeader(headers: Record<string, string>): void
    
    isAddress(address: string): boolean
    fromHex(hex: string): string
    toHex(str: string): string
    fromSun(sun: number): number
    toSun(trx: number): number
    
    trx: {
      getBalance(address: string): Promise<number>
      sendTransaction(to: string, amount: number, from?: string): Promise<TransactionResult>
      sign(transaction: any, privateKey?: string): Promise<any>
      sendRawTransaction(signedTransaction: any): Promise<any>
      getTransaction(txid: string): Promise<any>
      getTransactionInfo(txid: string): Promise<any>
      getAccount(address: string): Promise<any>
      getAccountResources(address: string): Promise<any>
      getCurrentBlock(): Promise<any>
      getBlock(blockNumber: number): Promise<any>
      getBlockByHash(hash: string): Promise<any>
      listNodes(): Promise<any>
      getNodeInfo(): Promise<any>
      getChainParameters(): Promise<any>
      timeUntilNextVoteCycle(): Promise<number>
      getTokensIssuedByAddress(address: string): Promise<any>
      getTokenFromID(tokenId: string): Promise<any>
      listTokens(limit?: number, offset?: number): Promise<any>
      getTokenListByName(tokenName: string): Promise<any>
      getTokenByID(tokenId: string): Promise<any>
      getReward(address: string): Promise<any>
      getUnconfirmedReward(address: string): Promise<any>
      getBrokerage(address: string): Promise<any>
      getApprovedList(transaction: any): Promise<any>
      getSignWeight(transaction: any): Promise<any>
    }

    contract(): {
      at(address: string): Promise<any>
    }

    address: {
      fromHex(hex: string): string
      toHex(address: string): string
      fromPrivateKey(privateKey: string): string
    }

    utils: {
      accounts: {
        generateAccount(): {
          privateKey: string
          publicKey: string
          address: {
            base58: string
            hex: string
          }
        }
      }
      crypto: {
        generateAccount(): {
          privateKey: string
          publicKey: string
          address: string
        }
      }
    }
  }

  export = TronWeb
}