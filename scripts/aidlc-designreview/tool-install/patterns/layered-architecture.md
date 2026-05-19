<!--
# Layered Architecture

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

# Layered Architecture

## Category

System Architecture

## Description

Organizes the application into horizontal layers where each layer has a specific responsibility and dependencies flow in one direction (typically top-down). Common layers include presentation, business logic, data access, and infrastructure.

## When to Use

Use layered architecture when you need clear separation of concerns, want to enforce dependency rules, or are building enterprise applications with well-defined responsibility boundaries.

## Example

A web application with presentation layer (UI controllers), service layer (business logic), repository layer (data access), and domain layer (entities and business rules). Each layer only depends on layers below it.
