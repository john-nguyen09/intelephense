<?php

const TEST_CONST1 = 2;
define('TEST_CONST', 1);

$array = array();

function testFunction()
{

}

function testFunction2(int $value, &$ref, ...$ref2)
{
    return false;
}

class TestClass
{
    const CLASS_CONSTANT = 5;
    const CONSTANT1 = 4, CONSTANT2 = 3.1, PI = 3.14;
    public static $staticTestProperty;
    public $testProperty;
    public $testProp1, $testProp2, $testProp3 = 'prop3';

    public $initProp1 = true;
    public $initProp2 = 5;
    public $initProp3 = 5.1;
    public $initProp4 = new TestClass();

    public function testMethod($testParameter)
    {
        $array = array();
    }

    public function testMethod2()
    {
        
    }
}

class TestClass2 extends TestClass
{

}

interface TestInterface
{
    public function testInterfaceMethod();
    public function testInterfaceMethod2();
}

interface TestInterface2 extends TestInterface
{
    public function testInterfaceMethod3();
}

class TestClass3 implements TestInterface, TestInterface2
{
    
}

trait TestTrait
{
    public function traitMethod1()
    {

    }
}

class TestClass4
{
    use TestTrait;

    public static function staticMethod1()
    {

    }
}

new class extends TestClass4 implements TestInterface2 {
    public function testInterfaceMethod3()
    {
        
    }
};

$testObj1 = new \TestClass();
$testFunction1 = static function&() use ($testObj1, $array) {

};

try {
    testFunction();
} catch (Exception $e) {

}

abstract class TestAbstract1
{
    public abstract function testFunction1();
}