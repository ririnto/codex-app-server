#!/bin/sh
fallback=$1
shift
if [ -n "$(command -v "$1")" ]; then
	exec "$@"
fi
if [ "$fallback" = --pnpm ]; then
	exec pnpm exec "$@"
fi
exec npm exec --yes --package=husky@^9.1.7 -- npm exec --yes --install-links --package="$fallback" -- "$@"
