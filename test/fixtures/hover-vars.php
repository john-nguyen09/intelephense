<?php
class Foo {
    function bar():int{}
}
function factory():Foo{}
$var = factory();
$var = $var->bar();
