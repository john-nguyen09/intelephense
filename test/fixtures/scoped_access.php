<?php
class Test {
    public const FOO = 1;
    public static $bar = 1;
    public static function baz(){}
    private static $baz = 1;
}
$var = Test::FOO;
$var = Test::$bar;
$var = Test::baz();
