import { Predicate, TreeVisitor, TreeTraverser, NameIndex } from "../types";
import { PhpSymbol, SymbolKind, SymbolModifier } from "../symbol";
import { LevelUp } from "levelup";
import { AbstractLevelDOWN, AbstractIteratorOptions } from "abstract-leveldown";
import * as Subleveldown from 'subleveldown';
import { CodecEncoder } from "level-codec";
import { CompletionIndex, CompletionValue } from "./completionIndex";
import { Position } from "vscode-languageserver";
import { elapsed } from "../util";

export type PhpSymbolIdentifier = [string, string, number, number, number, number];

export namespace PhpSymbolIdentifier {
    export function create(symbol: PhpSymbol): PhpSymbolIdentifier {
        const uri = symbol.location ? symbol.location.uri : '';
        const end: Position = symbol.location && symbol.location.range ?
            symbol.location.range.end : { line: 0, character: 0 };
        const start = symbol.location && symbol.location.range ?
            symbol.location.range.start : { line: 0, character: 0 };

        return [
            symbol.name,
            uri,
            end.line,
            end.character,
            start.line,
            start.character,
        ];
    }
}

export class SymbolIndex implements TreeVisitor<PhpSymbol> {
    public static readonly NAMED_SYMBOL_KIND_MASK = SymbolKind.Namespace |
        SymbolKind.Class | SymbolKind.Interface | SymbolKind.Trait |
        SymbolKind.Method | SymbolKind.Function | SymbolKind.File |
        SymbolKind.Constant | SymbolKind.ClassConstant;
    public static readonly NAMED_SYMBOL_EXCLUDE_MODIFIERS = SymbolModifier.Magic;
    
    public static isNamedSymbol(s: PhpSymbol) {
        return (s.kind & this.NAMED_SYMBOL_KIND_MASK) && !(s.modifiers & this.NAMED_SYMBOL_EXCLUDE_MODIFIERS);
    }

    private _namedSymbols: LevelUp<AbstractLevelDOWN<string, PhpSymbol>>;
    private _namedSymbolJobs: Promise<void>[] = [];
    private _globalVariables: LevelUp<AbstractLevelDOWN<string, PhpSymbol>>;
    private _globalVariableJobs: Promise<void>[] = [];
    private _completion: CompletionIndex;
    private _completionJobs: Promise<void>[] = [];

    constructor(db: LevelUp) {
        this._namedSymbols = Subleveldown(db, 'named-symbols', {
            valueEncoding: SymbolEncoder,
        });
        this._globalVariables = Subleveldown(db, 'symbol-kinds', {
            keyEncoding: 'json',
            valueEncoding: SymbolEncoder,
        });
        this._completion = new CompletionIndex(db, 'symbol-completion');
    }

    async index(root: PhpSymbol) {
        let traverser = new TreeTraverser([root]);

        traverser.traverse(this);
        
        await Promise.all([
            ...this._namedSymbolJobs,
            ...this._globalVariableJobs,
            ...this._completionJobs,
        ]);
        this._namedSymbolJobs = [];
        this._globalVariableJobs = [];
        this._completionJobs = [];
    }

    async removeMany(uri: string) {
        await Promise.all([
            this.deleteSymbols(this._globalVariables, {}, (s: PhpSymbol) => {
                return s.location.uri === uri;
            }),
            this.deleteSymbols(this._namedSymbols, {
                gte: uri,
                lte: uri + '\xFF',
            }).then((namedSymbols) => {
                const promises: Promise<void>[] = [];

                for (const symbol of namedSymbols) {
                    promises.push(this._completion.del(uri, symbol.name));
                }

                return Promise.all(promises);
            }),
        ]);
    }

    async find(key: string) {
        return await this.findSymbols(this._namedSymbols, {
            gte: key,
            lte: key + '\xFF',
        });
    }

    async filter(filter: Predicate<PhpSymbol>) {
        return (await this.findSymbols(this._namedSymbols, {}))
            .filter(filter);
    }

    async match(text: string): Promise<PhpSymbol[]> {
        const completionValues = await this._completion.match(text);
        const promises: Promise<PhpSymbol>[] = [];

        for (const completionValue of completionValues) {
            promises.push(this._namedSymbols.get(SymbolIndex.getNamedSymbolKey(completionValue.identifier)));
        }

        return Promise.all(promises);
    }

    async getGlobalVariables() {
        return this.findSymbols(this._globalVariables, {});
    }
    
    preorder(node: PhpSymbol, spine: PhpSymbol[]) {
        if (SymbolIndex.isNamedSymbol(node)) {
            this._namedSymbolJobs.push(this._namedSymbols.put(SymbolIndex.getNamedSymbolKey(
                PhpSymbolIdentifier.create(node)
            ), node));

            if (node.modifiers !== SymbolModifier.Use) {
                this._completionJobs.push(this._completion.put(node));
            }
        }

        if (SymbolIndex._isGlobalVariables(node)) {
            this._globalVariableJobs.push(this._globalVariables.put(node.name, node));
        }

        return true;
    }

    private async deleteSymbols(db: LevelUp, options: AbstractIteratorOptions, predicate?: Predicate<PhpSymbol>) {
        return new Promise<PhpSymbol[]>((resolve, reject) => {
            const promises: Promise<void>[] = [];
            const results: PhpSymbol[] = [];

            db.createReadStream(options)
                .on('data', (data) => {
                    if (predicate && !predicate(data.value)) {
                        return;
                    }

                    results.push(data.value);
                    promises.push(db.del(data.key));
                })
                .on('end', () => {
                    Promise.all(promises).then(() => {
                        resolve(results);
                    });
                })
                .on('error', (err) => {
                    if (err) {
                        reject(err);
                    }
                });
        });
    }

    private async findSymbols(db: LevelUp, options: AbstractIteratorOptions): Promise<PhpSymbol[]> {
        return new Promise<PhpSymbol[]>((resolve, reject) => {
            const results: PhpSymbol[] = [];

            db.createValueStream(options)
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

    static getNamedSymbolKey(identifier: PhpSymbolIdentifier) {
        return identifier.join('#');
    }

    private static _isGlobalVariables(s: PhpSymbol) {
        return s.kind === SymbolKind.GlobalVariable;
    }
}

const SymbolEncoder: CodecEncoder = {
    type: 'symbol',
    encode: (symbol: PhpSymbol): string => {
        return JSON.stringify(symbol);
    },
    decode: (buffer: string): PhpSymbol => {
        return JSON.parse(buffer);
    },
    buffer: false,
}