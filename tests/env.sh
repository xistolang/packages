# Sourced by each test's run.sh right after it changes into its own folder, two levels below the repository root
# (tests/NAME or examples/NAME). Sets ROOT (this checkout), X (the xisto compiler: $XISTO, else xisto on PATH) and
# XISTO_PKGS (where `import "pg"` is found: this checkout, unless XISTO_PKGS is already set), and the helpers the
# database tests use to skip when their server is not reachable.
ROOT=$(cd ../.. && pwd)
X=${XISTO:-xisto}
case $X in */*) ;; *) X=$(command -v "$X") ;; esac
if [ -z "$X" ] || [ ! -x "$X" ]; then echo "FAIL: no xisto compiler (put xisto on PATH or set XISTO=/path/to/xisto)"; exit 1; fi
case $X in /*) ;; *) echo "FAIL: XISTO must be an absolute path when a test runs on its own ($X)"; exit 1 ;; esac
XISTO_PKGS=${XISTO_PKGS:-$ROOT}
export XISTO_PKGS
# as the whole suite runs (tests/run.sh): node: imports allowed, one time zone for xisto and the Node outputs
export XISTO_NODE_COMPAT=1
export TZ=${TZ:-America/New_York}
# up HOST PORT: something answers on that TCP port
up() { nc -z "$1" "$2" > /dev/null 2>&1; }
# url_host URL / url_port URL DEFAULT: the server of oracle://user:password@host:port/service, mongodb://host:port...
url_host() { echo "$1" | sed -E 's#^[a-z+]+://([^@/]*@)?\[?([^]:/,?]*).*#\2#'; }
url_port() { p=$(echo "$1" | sed -nE 's#^[a-z+]+://([^@/]*@)?[^:/,?]*:([0-9]+).*#\2#p'); echo "${p:-$2}"; }
