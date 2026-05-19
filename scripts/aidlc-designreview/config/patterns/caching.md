<!--
# Caching

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

# Caching

## Category

Scalability

## Description

Stores frequently accessed data in fast-access storage to reduce latency and database load. Can be implemented at various levels including application cache, database cache, and CDN cache.

## When to Use

Use caching for frequently accessed read-heavy data, when database queries are expensive, or when you need to reduce response times and improve scalability.

## Example

An application using Redis to cache user profile data and API responses. Cache-aside pattern checks cache first, queries database on miss, and stores result in cache with TTL for future requests.
