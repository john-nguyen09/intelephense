<?php
class Foo {
    function fooFn(){}
}
class Bar {
    function barFn(){}
}
$var = new Foo();
$fn = function(string $param) use ($var){
    $bar = new Bar();
    $var->fooFn();
    echo $param;
    $bar->barFn();
};