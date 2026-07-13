#!/bin/bash
# Two concurrent `vanguard __sidecar` children, exactly as Rust now spawns them.
mkfifo /tmp/vg_a_in /tmp/vg_b_in 2>/dev/null
node dist/cli/index.js __sidecar < /tmp/vg_a_in > /tmp/vg_a_out 2>/dev/null &
A=$!
node dist/cli/index.js __sidecar < /tmp/vg_b_in > /tmp/vg_b_out 2>/dev/null &
B=$!
exec 3>/tmp/vg_a_in
exec 4>/tmp/vg_b_in
echo '{"id":"1","method":"capabilities"}' >&3
echo '{"id":"2","method":"capabilities"}' >&4
sleep 3
echo "child A pid=$A alive=$(kill -0 $A 2>/dev/null && echo yes || echo no)"
echo "child B pid=$B alive=$(kill -0 $B 2>/dev/null && echo yes || echo no)"
echo "A answered: $(head -c 60 /tmp/vg_a_out)"
echo "B answered: $(head -c 60 /tmp/vg_b_out)"
exec 3>&-; exec 4>&-
wait $A $B 2>/dev/null
rm -f /tmp/vg_a_in /tmp/vg_b_in /tmp/vg_a_out /tmp/vg_b_out
