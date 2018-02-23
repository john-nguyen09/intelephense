<?php

class FirstClass
{
	public static function thisWorks()
	{

	}

	public function __construct()
	{
		self::thisWorks();
		$this->thisWorks();
	}
}

define('ISSUE_AFTER_THIS', 1);

class SecondClass
{
	public static function thisDoesNotWork()
	{

	}

	public function __construct()
	{
		self::thisDoesNotWork();
		$this->thisDoesNotWork();
	}
}
