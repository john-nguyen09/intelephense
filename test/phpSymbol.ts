import { PhpSymbol, SymbolKind } from '../src/symbol';
import {acronym} from '../src/utils';
import { assert } from 'chai';
import 'mocha';

describe('PhpSymbol', () => {

    describe('#acronym()', () => {

        it('Should return correct acronym for camel case fqn', () => {
            let s:PhpSymbol = {
                kind:SymbolKind.Class,
                name:'Foo\\MyFooClass',
                location: undefined,
            } 
            assert.equal(acronym(PhpSymbol.notFqn(s.name)), 'mfc');
        });

        it('Should return correct acronym for lower case underscore separated name', () => {
            let s:PhpSymbol = {
                kind:SymbolKind.Function,
                name:'_my_function',
                location: undefined,
            } 
            assert.equal(acronym(s.name), 'mf');
        });

        it('Should return correct acronym for camel case variable/property', () => {
            let s:PhpSymbol = {
                kind:SymbolKind.Variable,
                name:'$myProperty',
                location: undefined,
            } 
            assert.equal(acronym(s.name), 'mp');
        });

        it('Should return correct acronym for upper case underscore separated name', () => {
            let s:PhpSymbol = {
                kind:SymbolKind.Variable,
                name:'THIS_IS_A_CONSTANT',
                location: undefined,
            } 
            assert.equal(acronym(s.name), 'tiac');
        });

    });

    describe('#keys()', () => {

        it('Should return correct suffixes for camel case fqn', () => {
            let s:PhpSymbol = {
                kind:SymbolKind.Class,
                name:'Foo\\MyFooClass',
                location: undefined,
            }

            let expected = [
                'Foo\\MyFooClass'
            ];

            assert.deepEqual(PhpSymbol.keys(s), expected);
        });

        it('Should return correct suffixes for lower case underscore separated name', () => {
            let s:PhpSymbol = {
                kind:SymbolKind.Function,
                name:'_my_function',
                location: undefined,
            } 

            let expected = [
                '_my_function',
            ];

            assert.deepEqual(PhpSymbol.keys(s), expected);
        });

        it('Should return correct suffixes for camel case variable/property', () => {
            let s:PhpSymbol = {
                kind:SymbolKind.Variable,
                name:'$myProperty',
                location: undefined,
            } 

            let expected = [
                '$myProperty',
            ];

            assert.deepEqual(PhpSymbol.keys(s), expected);
        });

        it('Should return correct suffixes for upper case underscore separated name', () => {
            let s:PhpSymbol = {
                kind:SymbolKind.Variable,
                name:'THIS_IS_A_CONSTANT',
                location: undefined,
            } 

            let expected = [
                'THIS_IS_A_CONSTANT',
            ];

            assert.deepEqual(PhpSymbol.keys(s), expected);
        });

    });
    
});