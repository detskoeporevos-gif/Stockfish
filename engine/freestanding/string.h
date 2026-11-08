#ifndef GF_STRING_H
#define GF_STRING_H
#include <stddef.h>
void* memset(void*, int, size_t);
void* memcpy(void*, const void*, size_t);
void* memmove(void*, const void*, size_t);
int   memcmp(const void*, const void*, size_t);
size_t strlen(const char*);
char* strcpy(char*, const char*);
char* strncpy(char*, const char*, size_t);
int   strcmp(const char*, const char*);
int   atoi(const char*);
int   sprintf(char*, const char*, ...);
#endif
