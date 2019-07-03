<?php
namespace Test\Namespace;

use AnotherNamespace\Class1;
use \NS\{C11, C12, I10, function fn1, const CONST1};
use \NS1\C, \NS1\I, \NS1\T;
use function AnotherNamespace1\test_function as test_function1;
use const AnotherNamespace1\TEST_CONST;
use Nested1\{
    Nested2\Target,
    Nested3
};
