#!/bin/sh
psql -U "$POSTGRES_USER" -c "CREATE DATABASE judge_arena_test OWNER $POSTGRES_USER" || true
