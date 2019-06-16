import { Intelephense } from '../src/intelephense';
import { assert } from 'chai';
import 'mocha';
import { pathToUri } from '../src/util';
import { join } from 'path';

describe('intelephense', function(){

    describe('#initialise', function(){

        it('Built in symbols', async function(){

            await Intelephense.initialise(null);
            assert.isAbove(Intelephense.numberSymbolsKnown(), 1);

            let src = 
            `<?php
            class Result implements Iterator, ResultInterface
            {
                /**
                 * @var \mysqli|\mysqli_result|\mysqli_stmt
                 */
                protected $resource = null;

                function fn()
                {
                    $data = $this->resource->result_metadata();
                }
            }
            `;

            Intelephense.openDocument({uri:'test', text:src, languageId:'php', version:0});

        });

    });

    it('undefined storagePath', () =>{

        return Intelephense.initialise(null).then(()=>{

        });


    });

});