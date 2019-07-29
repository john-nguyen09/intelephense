import { PhpDoc, Tag, MethodTagParam, PhpDocParser } from '../src/phpDoc';
import { assert } from 'chai';
import 'mocha';

describe('PhpDocParser', function () {

    describe('#parse()', function () {

        it('Should parse class doc block', function () {

            let text = `/**
             * Class Summary.
             * Class Description.
             * @property int $property Property description
             * @property-read string $propertyRead Property read description
             * @property-write float $propertyWrite Property write description
             * @method float fn(int $p1, string $p2) Method description
             */`

            const phpDoc = PhpDocParser.parse(text);

            let expectedProperty = {
                tagName: '@property',
                typeString: 'int',
                name: '$property',
                description: 'Property description'
            }

            let expectedPropertyRead = {
                tagName: '@property-read',
                typeString: 'string',
                name: '$propertyRead',
                description: 'Property read description'
            }

            let expectedPropertyWrite = {
                tagName: '@property-write',
                typeString: 'float',
                name: '$propertyWrite',
                description: 'Property write description'
            }

            let expectedMethod = <Tag>{
                tagName: '@method',
                isStatic: false,
                typeString:'float',
                name:'fn',
                description:'Method description',
                parameters:[
                    {
                        typeString:'int',
                        name:'$p1'
                    },
                    {
                        typeString:'string',
                        name:'$p2'
                    }
                ]
            }

            assert.equal(phpDoc.text, 'Class Summary.\nClass Description.');
            assert.deepEqual(phpDoc.propertyTags[0], expectedProperty);
            assert.deepEqual(phpDoc.propertyTags[1], expectedPropertyRead);
            assert.deepEqual(phpDoc.propertyTags[2], expectedPropertyWrite);
            assert.deepEqual(phpDoc.methodTags[0], expectedMethod);
            //console.log(JSON.stringify(phpDoc.findParamTag('$value'), null, 4));

        });


        it('Should parse function doc block', function () {

            let text = `/**
             * Function summary.
             * Function description.
             * @param \\My\\Param $myParam Param description
             * @return \\My\\ReturnType Return description
             */`

            let phpDoc = PhpDocParser.parse(text);

            let expectedParam = {
                tagName: '@param',
                typeString: '\\My\\Param',
                name: '$myParam',
                description: 'Param description'
            }

            let expectedReturn = {
                tagName: '@return',
                typeString: '\\My\\ReturnType',
                name: '',
                description: 'Return description'
            }

            //console.log(JSON.stringify(phpDoc, null, 4));
            assert.equal(phpDoc.text, 'Function summary.\nFunction description.');
            assert.deepEqual(phpDoc.findParamTag('$myParam'), expectedParam);
            assert.deepEqual(phpDoc.returnTag, expectedReturn);

        });

        it('Should parse named @var', function () {

            let text = `/** @var Foo $v description */`;
            let phpDoc = PhpDocParser.parse(text);
            let expected = {
                tagName: '@var',
                typeString: 'Foo',
                name: '$v',
                description: 'description'
            };
            //console.log(JSON.stringify(phpDoc.findVarTag('$v'), null, 4));
            assert.deepEqual(phpDoc.findVarTag('$v'), expected);
        });

        it('Should parse nameless @var', function () {

            let text = `/** @var Foo description */`;
            let phpDoc = PhpDocParser.parse(text);
            let expected = {
                tagName: '@var',
                typeString: 'Foo',
                name: '',
                description: 'description'
            };
            //console.log(JSON.stringify(phpDoc.findVarTag('$v'), null, 4));
            assert.deepEqual(phpDoc.findVarTag('$v'), expected);
        });


        it('@method tag with param with no type', () => {

            let text = '@method ActiveQuery hasOne($class, array $link) see [[BaseActiveRecord::hasOne()]] for more info';
            let phpDoc = PhpDocParser.parse(text);
            let expected = [
                    {
                        tagName: "@method",
                        isStatic: false,
                        typeString: "ActiveQuery",
                        name: "hasOne",
                        parameters: [
                            {
                                typeString: "mixed",
                                name: "$class"
                            },
                            {
                                typeString: "array",
                                name: "$link"
                            }
                        ],
                        description: "see [[BaseActiveRecord::hasOne()]] for more info"
                    }
                ];
            //console.log(JSON.stringify(phpDoc, null, 4));
            assert.deepEqual(phpDoc.methodTags, expected);

        });

        it('@method static', function () {

            let text = `/** @method static string fn(int p) description */`;
            let phpDoc = PhpDocParser.parse(text);
            let expected = <Tag[]>[
                {
                    "tagName": "@method",
                    "isStatic": true,
                    "typeString": "string",
                    "name": "fn",
                    "parameters": [
                        {
                            "typeString": "int",
                            "name": "p"
                        }
                    ],
                    "description": "description"
                }
            ];
            //console.log(JSON.stringify(phpDoc.methodTags, null, 4));
            assert.deepEqual(phpDoc.methodTags, expected);
        });


    });


});