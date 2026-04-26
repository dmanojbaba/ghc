#!/bin/bash

CATT_CFG="--volume /home/pi/dotfiles/catt/catt.cfg:/root/.config/catt/catt.cfg"

if echo "$2" | grep -Eq '^http'; then
    /usr/bin/docker run --name catt --net=host --rm $CATT_CFG catt:latest /bin/bash -c "catt -d $1 cast $2"
else
    /usr/bin/docker run --name catt --net=host --rm $CATT_CFG catt:latest /bin/bash -c "catt $*"
fi
