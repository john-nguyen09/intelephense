import { WordSeparator } from "./wordSeparator";
import { LevelUp } from "levelup";
import * as Subleveldown from 'subleveldown';
import { AbstractLevelDOWN, AbstractIteratorOptions } from "abstract-leveldown";
import { CodecEncoder } from "level-codec";
import { PhpSymbol } from "../../symbol";
import { PhpSymbolIdentifier } from "../symbolIndex";

export interface CompletionValue {
    uri: string;
    identifier: PhpSymbolIdentifier;
}

export class CompletionIndex {
    public static readonly INFO_SEP = '#';
    public static LIMIT = 10000;

    private db: LevelUp<AbstractLevelDOWN<string, CompletionValue[]>>;

    constructor(db: LevelUp, prefix: string) {
        this.db = Subleveldown(db, prefix, {
            valueEncoding: CompletionEncoder,
        });
    }

    async put(symbol: PhpSymbol) {
        const tokens = WordSeparator.getTokens(symbol.name);
        const uri = symbol.location ? symbol.location.uri : '';
        const previousResultMap = new Map<string, CompletionValue[]>();

        for (const token of tokens) {
            const indexKey = CompletionIndex.getKey(uri, token);
            let previousResults: CompletionValue[] = [];
            if (previousResultMap.has(indexKey)) {
                previousResults = previousResultMap.get(indexKey);
            } else {
                previousResults = await this.get(uri, token);
            }

            previousResults.push({
                uri: uri,
                identifier: PhpSymbolIdentifier.create(symbol),
            });
            previousResultMap.set(indexKey, previousResults);
        }

        const promises: Promise<void>[] = [];
        for (const [indexKey, results] of previousResultMap.entries()) {
            promises.push(this.db.put(indexKey, results));
        }

        await Promise.all(promises);
    }

    async get(uri: string, token: string): Promise<CompletionValue[]> {
        const results: CompletionValue[] = [];

        try {
            const values = await this.db.get(CompletionIndex.getKey(uri, token));

            results.push(...values);
        } catch (err) { }

        return results;
    }

    async match(keyword: string): Promise<CompletionValue[]> {
        const db = this.db;
        let completions: CompletionValue[] = [];

        return new Promise<CompletionValue[]>((resolve, reject) => {
            const options: AbstractIteratorOptions<string> = {
                limit: CompletionIndex.LIMIT,
            };

            if (keyword.length !== 0) {
                options.gte = keyword;
                options.lte = keyword + '\xFF';
            }
            const readStream: NodeJS.ReadableStream = db.createValueStream(options);

            readStream
                .on('data', (data) => {
                    completions.push(...data);
                })
                .on('end', () => {
                    resolve(completions);
                })
                .on('reject', (err) => {
                    if (err) {
                        reject(err);
                    }
                });
        });
    }

    async del(uri: string, name: string) {
        if (typeof name !== 'string') {
            return;
        }

        const tokens = WordSeparator.getTokens(name);
        const promises: Promise<void>[] = [];

        for (let token of tokens) {
            promises.push(this.db.del(CompletionIndex.getKey(uri, token)));
        }

        await Promise.all(promises);
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