<?php

if (true) {
    $first = new TestClass();
    $first->initProp1;
    $first->testMethod();
} else if (true) {

} else {
    
}

/**
 * @return TestClass
 */
function refFunction1() {
}

$value = 1;
$value2 = &$value;

TestClass::$staticTestProperty;
TestClass::CLASS_CONSTANT;
TestClass4::staticMethod1();

if ($value instanceof TestClass) {

}

foreach ($value as $key => $val) {

}

try {
    throw new Exception();
} catch (Exception | Throwable | TestClass $ex) {

} catch (Exception $ex) {

} catch (Expception | $ex) {

} catch (|Exception $e1) {

} catch (Exception | Throwable $ex) {
    
}

switch ($value) {
    case 1:
        break;
    default:
        break;
}

testFunction();

list ($firstValue, $secondValue) = ['one', 1];
$array1 = ['PI', 3.14];

echo $array1[0];
