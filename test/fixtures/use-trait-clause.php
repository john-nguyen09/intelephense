<?php
namespace Foo;
trait Bar {}
namespace Bar;
class Foo {
    use Bar;
}
