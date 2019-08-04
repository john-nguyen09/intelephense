<?php
class Test {
    const FOO = 1;
    static public $bar;
    static function baz(){}
}
Test::FOO;
Test::$bar;
Test::baz();
