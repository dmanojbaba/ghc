#!/bin/bash

if echo "$2" | grep -Eq '^http'; then
    /usr/bin/docker exec catt /bin/bash -c "catt -d $1 cast $2"
else
    /usr/bin/docker exec catt /bin/bash -c "catt $*"
fi
