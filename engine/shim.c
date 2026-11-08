/*
  GambitFish — tiny freestanding libc shim for the wasm32 build, plus the
  clock import from JS. GPL-3.0.
*/

#include <stddef.h>
#include <stdint.h>

int sprintf(char* out, const char* fmt, ...);

#if defined(__wasm__) && !defined(__wasi__)
__attribute__((import_module("env"), import_name("now_ms")))
extern int64_t env_now_ms(void);
int64_t gf_now_ms(void) { return env_now_ms(); }
#else
#include <sys/time.h>
int64_t gf_now_ms(void) {
    struct timeval tv;
    gettimeofday(&tv, 0);
    return (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}
#endif

void* memset(void* d, int c, size_t n) {
    unsigned char* p = (unsigned char*)d;
    while (n--) *p++ = (unsigned char)c;
    return d;
}

void* memcpy(void* d, const void* s, size_t n) {
    unsigned char* dp = (unsigned char*)d;
    const unsigned char* sp = (const unsigned char*)s;
    while (n--) *dp++ = *sp++;
    return d;
}

void* memmove(void* d, const void* s, size_t n) {
    unsigned char* dp = (unsigned char*)d;
    const unsigned char* sp = (const unsigned char*)s;
    if (dp < sp) { while (n--) *dp++ = *sp++; }
    else { dp += n; sp += n; while (n--) *--dp = *--sp; }
    return d;
}

int memcmp(const void* a, const void* b, size_t n) {
    const unsigned char* x = (const unsigned char*)a;
    const unsigned char* y = (const unsigned char*)b;
    while (n--) { if (*x != *y) return *x - *y; x++; y++; }
    return 0;
}

size_t strlen(const char* s) { size_t n = 0; while (s[n]) n++; return n; }

char* strcpy(char* d, const char* s) { char* r = d; while ((*d++ = *s++)) {} return r; }

char* strncpy(char* d, const char* s, size_t n) {
    size_t i = 0;
    for (; i < n && s[i]; i++) d[i] = s[i];
    for (; i < n; i++) d[i] = 0;
    return d;
}

int strcmp(const char* a, const char* b) {
    while (*a && *a == *b) { a++; b++; }
    return (unsigned char)*a - (unsigned char)*b;
}

int atoi(const char* s) {
    int sign = 1, v = 0;
    while (*s == ' ') s++;
    if (*s == '-') { sign = -1; s++; }
    else if (*s == '+') s++;
    while (*s >= '0' && *s <= '9') { v = v * 10 + (*s - '0'); s++; }
    return sign * v;
}

/* minimal sprintf: %d, %s, %c, %u, %% */
int sprintf(char* out, const char* fmt, ...) {
    __builtin_va_list ap;
    char* o = out;
    __builtin_va_start(ap, fmt);
    while (*fmt) {
        if (*fmt != '%') { *o++ = *fmt++; continue; }
        fmt++;
        if (*fmt == 'd' || *fmt == 'i') {
            int v = __builtin_va_arg(ap, int);
            char tmp[16];
            int n = 0, neg = 0;
            unsigned int u;
            if (v < 0) { neg = 1; u = (unsigned int)(-v); }
            else u = (unsigned int)v;
            if (!u) tmp[n++] = '0';
            while (u) { tmp[n++] = (char)('0' + u % 10); u /= 10; }
            if (neg) *o++ = '-';
            while (n) *o++ = tmp[--n];
            fmt++;
        } else if (*fmt == 'u') {
            unsigned int u = __builtin_va_arg(ap, unsigned int);
            char tmp[16];
            int n = 0;
            if (!u) tmp[n++] = '0';
            while (u) { tmp[n++] = (char)('0' + u % 10); u /= 10; }
            while (n) *o++ = tmp[--n];
            fmt++;
        } else if (*fmt == 's') {
            const char* s = __builtin_va_arg(ap, const char*);
            if (!s) s = "(null)";
            while (*s) *o++ = *s++;
            fmt++;
        } else if (*fmt == 'c') {
            *o++ = (char)__builtin_va_arg(ap, int);
            fmt++;
        } else if (*fmt == '%') {
            *o++ = '%';
            fmt++;
        } else {
            *o++ = '%';
        }
    }
    *o = 0;
    __builtin_va_end(ap);
    return (int)(o - out);
}

extern unsigned char __heap_base;
static unsigned long heapTop = 0;
void* malloc(size_t size) {
    unsigned long base;
    if (!heapTop) heapTop = (unsigned long)&__heap_base;
    base = (heapTop + 15) & ~15UL;
    heapTop = base + size;
    return (void*)base;
}
void free(void* p) { (void)p; }
int abs(int v) { return v < 0 ? -v : v; }
long labs(long v) { return v < 0 ? -v : v; }

int snprintf(char* out, size_t n, const char* fmt, ...) {
    char tmp[512];
    int r;
    __builtin_va_list ap;
    __builtin_va_start(ap, fmt);
    (void)ap;
    __builtin_va_end(ap);
    r = sprintf(tmp, fmt);
    if (n) { size_t i; for (i = 0; i + 1 < n && tmp[i]; i++) out[i] = tmp[i]; out[i] = 0; }
    return r;
}

