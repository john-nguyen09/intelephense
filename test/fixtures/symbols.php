<?php

define('TEST_CONST', 1);

$array = array();

function testFunction()
{

}

class TestClass
{
    const CLASS_CONSTANT = 5;
    public static $staticTestProperty;
    public $testProperty;

    public function testMethod($testParameter)
    {
        $array = array();
    }

    public function testMethod2()
    {
        
    }
}

interface TestInterface
{
    public function testInterfaceMethod();
    public function testInterfaceMethod2();
}