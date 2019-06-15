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
    private _tables: Map<string, SymbolTable>;

    constructor(db: LevelUp) {
        this._db = Subleveldown(db, SymbolTableIndex.PREFIX, {
            valueEncoding: SymbolTableEncoder,
        });
        this._tables = new Map<string, SymbolTable>();
    }

    count() {
        return this._count;
    }

    *tables() {
        for (let key of this._tables.keys()) {
            yield this._tables.get(key);
        }
    }

    async add(table: SymbolTable) {
        if (this._tables.has(table.uri)) {
            throw new Error(`Duplicate key ${table.uri}`);
        }

        this._tables.set(table.uri, table);
        await this._db.put(table.uri, table);
        ++this._count;
    }

    async remove(uri: string) {
        if (!this._tables.has(uri)) {
            return undefined;
        }

        let table = this._tables.get(uri);
        this._tables.delete(uri);
        await this._db.del(uri);
        --this._count;

        return table;
    }

    async find(uri: string) {
        return this._tables.get(uri);
    }

    async findBySymbol(s: PhpSymbol) {
        if (!s.location) {
            return undefined;
        }

        return this.find(s.location.uri);
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