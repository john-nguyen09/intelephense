import { PhpSymbol, SymbolKind } from '../src/symbol';
import {NameIndex} from '../src/types';
import { assert } from 'chai';
import 'mocha';

let symbols: PhpSymbol[] = [
    {
        kind: SymbolKind.Class,
        name: 'Foo\\MyFoo',
        location: null,
    },
    {
        kind: SymbolKind.Property,
        name: 'fooBar',
        location: null,
    },
    {
        kind: SymbolKind.Method,
        name: 'myFooFunction',
        location: null,
    },
    {
        kind: SymbolKind.Method,
        name: 'myBarFunction',
        location: null,
    },
    {
        kind: SymbolKind.Interface,
        name: 'Bar\\MyBar',
        location: null,
    },
    {
        kind:SymbolKind.Function,
        name: 'zoo',
        location: null,
    },
    {
        kind: SymbolKind.Class,
        name: 'Foo\\myFoo',
        location: null,
    }
];



describe('SymbolIndex', () => {

    describe('#match()', () => {

        let index = new NameIndex<PhpSymbol>(PhpSymbol.keys);
        index.addMany(symbols);

        it('Should return single element array of matching item when given a unique string that exists', () => {
            let match = index.match('Foo\\MyFoo');
            assert.isArray(match);
            assert.equal(match.length, 1);
            assert.strictEqual(match[0], symbols[0]);
        });

        it('Should return correct array of matching items when given a non unique string that exists', () => {
            let match = index.match('myFoo');
            assert.isArray(match);
            assert.equal(match.length, 2);
            assert.deepEqual(match, [symbols[2], symbols[6]]);
        });

        it('Should return empty array on no matches', ()=>{
            let match = index.match('jdslkfjl');
            assert.isArray(match);
            assert.lengthOf(match, 0);
        });

        

    });


    
});