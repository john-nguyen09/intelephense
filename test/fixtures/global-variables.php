<?php

/**
 * Database connection. Used for all access to the database.
 * @global database $DB
 * @name $DB
 */
global $DB;

/**
 * @var database $test_class
 */
$test_class = null;

interface database {
    public function read_records();
    public function write_records();
}
