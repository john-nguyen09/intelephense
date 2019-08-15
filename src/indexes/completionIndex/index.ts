import { WordSeparator } from "./wordSeparator";
import { LevelUp } from "levelup";
import * as Subleveldown from 'subleveldown';
import { AbstractLevelDOWN, AbstractIteratorOptions, AbstractBatch } from "abstract-leveldown";
import { CodecEncoder } from "level-codec";
import { PhpSymbol } from "../../symbol";
import { PhpSymbolIdentifier, SymbolIndex } from "../symbolIndex";

export interface CompletionValue {
    uri: string;
    identifier: PhpSymbolIdentifier;
}

export class CompletionIndex {
    public static readonly INFO_SEP = '#';

    private db: LevelUp<AbstractLevelDOWN<string, CompletionValue>>;

    constructor(db: LevelUp, prefix: string) {
        this.db = Subleveldown(db, prefix, {
            valueEncoding: CompletionEncoder,
        });
    }

    async put(symbol: PhpSymbol) {
        if (typeof symbol.name === 'undefined') {
            console.log(symbol);
        }

        const tokens = WordSeparator.getTokens(symbol.name);
        const uri = symbol.location ? symbol.location.uri : '';
        const inputs: AbstractBatch<string, CompletionValue>[] = [];
        const symbolIdentifier = PhpSymbolIdentifier.create(symbol);

        for (const token of tokens) {
            const indexKey = CompletionIndex.getKey(uri, token);
            inputs.push({
                type: 'put',
                key: indexKey + '#' + SymbolIndex.getSymbolKey(symbolIdentifier),
                value: {
                    uri: uri,
                    identifier: symbolIdentifier,
                },
            });
        }
        await this.db.batch(inputs);
    }

    async get(uri: string, token: string): Promise<CompletionValue[]> {
        return new Promise<CompletionValue[]>((resolve, reject) => {
            const results: CompletionValue[] = [];
            const prefix = CompletionIndex.getKey(uri, token);
    
            this.db.createValueStream({
                gte: prefix,
                lte: prefix + '\xFF',
            })
            .on('data', (data) => {
                results.push(data);
            })
            .on('end', () => {
                resolve(results);
            })
            .on('error', (err) => {
                if (err) {
                    reject(err);
                }
            });
        });
    }

    match(keyword: string) {
        const options: AbstractIteratorOptions<string> = {};

        if (keyword.length !== 0) {
            options.gte = keyword;
            options.lte = keyword + '\xFF';
        }

        return this.db.iterator(options);
    }

    async del(uri: string, name: string) {
        if (typeof name !== 'string') {
            return;
        }

        return new Promise<void>((resolve, reject) => {
            const tokens = WordSeparator.getTokens(name);
            const promises: Promise<void>[] = [];

            for (const token of tokens) {
                const indexKey = CompletionIndex.getKey(uri, token);

                this.db.createKeyStream({
                    gte: indexKey,
                    lte: indexKey + '\xFF',
                })
                .on('data', (data) => {
                    promises.push(this.db.del(data));
                })
                .on('end', () => {
                    Promise.all(promises).then(() => {
                        resolve();
                    });
                })
                .on('error', (err) => {
                    if (err) {
                        reject(err);
                    }
                });
            }
        });
    }

    public static getKey(uri: string, token: string) {
        return `${token}${CompletionIndex.INFO_SEP}${uri}`;
    }
}

const CompletionEncoder: CodecEncoder = {
    type: 'completion-encoding',
    encode: (value: CompletionValue[]): string => {
        return JSON.stringify(value);
    },
    decode: (buffer: string): CompletionValue[] => {
        return JSON.parse(buffer);
    },
    buffer: false
};