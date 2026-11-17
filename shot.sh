#!/bin/bash
# usage: shot.sh out.png width height file1.svg file2.svg ...
out=$1; w=$2; h=$3; shift 3
html=/tmp/contact_$$.html
echo "<html><body style='margin:0;background:#888;display:grid;grid-template-columns:repeat(${COLS:-3},1fr);gap:6px;padding:6px'>" > $html
for f in "$@"; do echo "<div style='background:#fff'><img src='file://$(realpath $f)' style='width:100%;display:block'><div style='font:12px sans-serif;padding:2px 6px'>$(basename $f)</div></div>" >> $html; done
echo "</body></html>" >> $html
google-chrome --headless=new --no-sandbox --disable-gpu --hide-scrollbars --allow-file-access-from-files --screenshot=$out --window-size=$w,$h file://$html >/dev/null 2>&1
rm -f $html
ls -la $out | awk '{print $5, $9}'
