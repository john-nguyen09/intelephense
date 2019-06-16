import {NameResolver} from '../src/nameResolver';
import {TypeString} from '../src/typeString'
import {ParsedDocument} from '../src/parsedDocument';
import {SymbolKind, PhpSymbol} from '../src/symbol';
import { assert } from 'chai';
import 'mocha';


describe('TypeString', function(){

    describe('#nameResolve', function(){

        it('Should not resolve keywords and built in types', function(){
            let resolver = new NameResolver();
            resolver.namespace = {kind:SymbolKind.Namespace, name: 'Foo\\Bar', location: null};
            let ts = 'int|string|array|null|mixed|float';
            assert.equal(TypeString.nameResolve(ts, resolver), ts);
        });
        
        it('Should resolve non keywords/built-ins', function(){
            let resolver = new NameResolver();
            resolver.namespace = {kind:SymbolKind.Namespace, name: 'Foo\\Bar', location: null};
            let ts = 'Baz';
            assert.equal(TypeString.nameResolve(ts, resolver), 'Foo\\Bar\\Baz');
        });

        it('Should remove leading backslash from fqn', function(){
            let resolver = new NameResolver();
            resolver.namespace = {kind:SymbolKind.Namespace, name: 'Foo\\Bar', location: null};
            let ts = '\\Baz';
            assert.equal(TypeString.nameResolve(ts, resolver), 'Baz');
        });

    });

});