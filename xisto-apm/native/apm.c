/* xisto-apm: what the tracer needs from the runtime that the language does not give.
   - isPromise(v): the value an fn handed to tracer.trace() returned is a promise (the span ends when it settles)
   - onSettle(p, cb): cb(failed, error) once p settles, without changing what the program sees of p (as Node's
     dd-trace does with p.then(finish, finish)): the reaction made here returns nothing, so it never rejects. */

typedef struct { xs_closure base; xs_closure *user; } xn_apm_cl;
static void xn_apm_cl_free(void *p) {
    xn_apm_cl *c = p;
    if (c->user) xs_release_(c->user);
    xs_obj_free(p);
}
static void xn_apm_cl_print(void *p) { (void)p; fputs("[Function]", XS_OUT); }
static void xn_apm_fire(void *c, bool failed, void *err) {
    xs_closure *u = ((xn_apm_cl *)c)->user;
    ((void (*)(void *, bool, void *))u->fn)(u, failed, err);
}
/* the fulfilled callbacks, one per kind of value the promise holds (xs_pcall passes it with that C type) */
static void xn_apm_ok_d(void *c, double v) { (void)v; xn_apm_fire(c, false, NULL); }
static void xn_apm_ok_i(void *c, int64_t v) { (void)v; xn_apm_fire(c, false, NULL); }
static void xn_apm_ok_b(void *c, bool v) { (void)v; xn_apm_fire(c, false, NULL); }
static void xn_apm_ok_p(void *c, void *v) { (void)v; xn_apm_fire(c, false, NULL); }
static void xn_apm_ok_n(void *c) { xn_apm_fire(c, false, NULL); }
static void xn_apm_err(void *c, void *e) { xn_apm_fire(c, true, e); }

static xs_closure *xn_apm_wrap(void *fn, xs_closure *user) {
    xn_apm_cl *c = xs_obj_alloc(sizeof *c, xn_apm_cl_free, xn_apm_cl_print);
    c->base.fn = fn;
    c->user = xs_retain_(user);
    return &c->base;
}

XS_NOINLINE bool xn_xisto_apm_isPromise(void *v) { return v && xs_type_of(v)->free == xs_promise_free; }

XS_NOINLINE void xn_xisto_apm_onSettle(void *v, xs_closure *cb) {
    if (!xn_xisto_apm_isPromise(v)) return;
    xs_promise *p = v;
    void *ok = p->kind == 0 ? (void *)xn_apm_ok_d : p->kind == 1 ? (void *)xn_apm_ok_i : p->kind == 2 ? (void *)xn_apm_ok_b
             : p->kind == 3 ? (void *)xn_apm_ok_p : (void *)xn_apm_ok_n;
    xs_closure *okc = xn_apm_wrap(ok, cb), *errc = xn_apm_wrap((void *)xn_apm_err, cb);
    xs_promise *d = xs_promise_then(p, 0, okc, 4, errc, 4, 4);
    xs_release_(okc);
    xs_release_(errc);
    xs_release_(d);
}

/* ids are 16 hex digits (64 bits): a random one (never 0) */
XS_NOINLINE xs_str *xn_xisto_apm_randomId(void) {
    uint64_t r = 0;
    while (r == 0) {
#if defined(__APPLE__)
        arc4random_buf(&r, sizeof r);
#else
        if (getentropy(&r, sizeof r) != 0) r = (uint64_t)xs_now() * 6364136223846793005ull + 1442695040888963407ull;
#endif
    }
    char b[17];
    snprintf(b, sizeof b, "%016llx", (unsigned long long)r);
    return xs_str_new(b, 16);
}
/* 16 hex digits as the decimal uint64 Datadog writes (x-datadog-trace-id, the Agent API); "0" when not hex */
XS_NOINLINE xs_str *xn_xisto_apm_hexToDec(xs_str *h) {
    uint64_t v = 0;
    for (int64_t i = 0; i < h->len; i++) {
        char c = h->data[i];
        int d = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
        if (d < 0) { v = 0; break; }
        v = v * 16 + (uint64_t)d;
    }
    char b[24];
    int n = snprintf(b, sizeof b, "%llu", (unsigned long long)v);
    return xs_str_new(b, (size_t)n);
}
/* a decimal uint64 as 16 hex digits ("" when not a number) */
XS_NOINLINE xs_str *xn_xisto_apm_decToHex(xs_str *d) {
    uint64_t v = 0;
    for (int64_t i = 0; i < d->len; i++) {
        char c = d->data[i];
        if (c < '0' || c > '9') return xs_str_new("", 0);
        v = v * 10 + (uint64_t)(c - '0');
    }
    char b[17];
    snprintf(b, sizeof b, "%016llx", (unsigned long long)v);
    return xs_str_new(b, 16);
}
/* the wall clock in nanoseconds (span start times) */
XS_NOINLINE double xn_xisto_apm_nowNs(void) { /* (a double: past 2^53 the language's int stops; ~256 ns of precision) */
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (double)ts.tv_sec * 1e9 + (double)ts.tv_nsec;
}
/* a monotonic clock in nanoseconds (span durations) */
XS_NOINLINE double xn_xisto_apm_monoNs(void) { return (double)xs_now(); }
XS_NOINLINE xs_str *xn_xisto_apm_hostname(void) {
    char b[256];
    if (gethostname(b, sizeof b) != 0) b[0] = 0;
    b[sizeof b - 1] = 0;
    return xs_str_new(b, strlen(b));
}

/* udpSend(host, port, payload): one datagram (DogStatsD to the Datadog Agent), from one socket kept open, never
   blocking: a full buffer or an unknown host loses this payload, as statsd clients do; false then */
static int xn_apm_udp_fd = -1;
static char xn_apm_udp_host[256];
static int xn_apm_udp_port;
static struct sockaddr_storage xn_apm_udp_addr;
static socklen_t xn_apm_udp_alen;
XS_NOINLINE bool xn_xisto_apm_udpSend(xs_str *host, int64_t port, xs_str *payload) {
    if (host->len <= 0 || host->len >= (int64_t)sizeof xn_apm_udp_host) return false;
    if (xn_apm_udp_fd < 0 || port != xn_apm_udp_port || strncmp(xn_apm_udp_host, host->data, (size_t)host->len) != 0 || xn_apm_udp_host[host->len] != 0) {
        struct addrinfo hints = {0}, *res = NULL;
        hints.ai_socktype = SOCK_DGRAM;
        char h[256], p[16];
        memcpy(h, host->data, (size_t)host->len);
        h[host->len] = 0;
        snprintf(p, sizeof p, "%d", (int)port);
        if (getaddrinfo(h, p, &hints, &res) != 0 || !res) return false;
        if (xn_apm_udp_fd >= 0) close(xn_apm_udp_fd);
        xn_apm_udp_fd = socket(res->ai_family, SOCK_DGRAM, 0);
        if (xn_apm_udp_fd < 0) { freeaddrinfo(res); return false; }
        fcntl(xn_apm_udp_fd, F_SETFL, O_NONBLOCK);
        memcpy(&xn_apm_udp_addr, res->ai_addr, res->ai_addrlen);
        xn_apm_udp_alen = res->ai_addrlen;
        freeaddrinfo(res);
        memcpy(xn_apm_udp_host, h, (size_t)host->len + 1);
        xn_apm_udp_port = (int)port;
    }
    return sendto(xn_apm_udp_fd, payload->data, (size_t)payload->len, 0, (struct sockaddr *)&xn_apm_udp_addr, xn_apm_udp_alen) == (ssize_t)payload->len;
}
