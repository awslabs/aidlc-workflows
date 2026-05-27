<!--
# Circuit Breaker

Copyright (c) 2026 AIDLC Design Reviewer Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
-->

# Circuit Breaker

## Category

Reliability

## Description

Prevents cascading failures by detecting when a service is failing and stopping requests to that service temporarily. Has three states: closed (normal), open (failing, rejecting requests), and half-open (testing recovery).

## When to Use

Use circuit breaker when calling remote services, when you need to prevent cascade failures, or when services need time to recover from failures without continuous request load.

## Example

A payment service calling an external payment gateway. After 5 consecutive failures, circuit opens for 30 seconds rejecting requests immediately. After timeout, allows test request in half-open state.
