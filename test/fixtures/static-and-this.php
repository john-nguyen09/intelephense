<?php
class A {
    /** @return static */
    static function factory(){}
    /** @return $this */
    function setter() {}
}
class B extends A {
    function fn(){}
}
$var = B::factory();
$var->fn();
$var->setter()->fn();
