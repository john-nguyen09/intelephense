import { SymbolTable } from "../symbolStore";
import { PhpSymbol } from "../symbol";
import { LevelUp } from "levelup";
import * as Subleveldown from 'subleveldown';
import { AbstractLevelDOWN } from "abstract-leveldown";
import { CodecEncoder } from "level-codec";


export class SymbolTableIndex {
    public static readonly PREFIX = 'symbol_table_index';

    private _count = 0;
    private _db: LevelUp<AbstractLevelDOWN<string, SymbolTable>>;
    private _openedTables: Map<string, SymbolTable>;

    constructor(db: LevelUp) {
        this._db = Subleveldown(db, SymbolTableIndex.PREFIX, {
            valueEncoding: SymbolTableEncoder,
        });
        this._openedTables = new Map<string, SymbolTable>();
    }

    count() {
        return this._count;
    }

    async add(table: SymbolTable, isOpen: boolean = false) {
        if (isOpen) {
            this._openedTables.set(table.uri, table);
        } else {
            await this._db.put(table.uri, table);
            ++this._count;
        }
    }

    async remove(uri: string) {
        if (this._openedTables.has(uri)) {
            const table = await this.find(uri);

            this._openedTables.delete(uri);

            return table;
        }

        const table = await this.find(uri);
        if (!table) {
            return undefined;
        }

        await this._db.del(uri);
        --this._count;

        return table;
    }

    async find(uri: string): Promise<SymbolTable | undefined> {
        if (this._openedTables.has(uri)) {
            return this._openedTables.get(uri);
        }

        let result: SymbolTable | undefined = undefined;
        try {
            result = await this._db.get(uri);
        } catch (e) { }

        return result;
    }

    async findBySymbol(s: PhpSymbol) {
        if (!s.location) {
            return undefined;
        }

        return await this.find(s.location.uri);
    }
}

export const SymbolTableEncoder: CodecEncoder = {
    type: 'SymbolTableEncoder',
    encode: (val: SymbolTable) => {
        return JSON.stringify(val.toJSON());
    },
    decode: (val: any) => {
        const data = JSON.parse(val);

        return SymbolTable.fromJSON(data);
    },
    buffer: false,
};