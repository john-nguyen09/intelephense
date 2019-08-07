<?php
function bar(string $a) { 
    echo $a;
    $fn = function ($b) use ($a) {
        echo $a, $b;
    }; 
}

class Foo {
    const C = 1;
    public $p;
    function __construct(){}
    function fn(){
        echo $this->p, self::C;
        bar(1);
    }
}

$v = new Foo();
$v->fn();
$v->p;
$v::C;
bar($v);
Foo::C;
