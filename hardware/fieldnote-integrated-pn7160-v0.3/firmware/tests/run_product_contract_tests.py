#!/usr/bin/env python3
"""Run actual sketch codec/rollback functions on a deterministic host fixture.

Extracts functions into a temporary TU rather than copying a second implementation.
The RF/controller, Arduino runtime, HTTP server and real tag behavior are not modeled.
"""
from pathlib import Path
import binascii
import hashlib
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
SKETCH = ROOT / "firmware/product_integrated_pn7160_v03/product_integrated_pn7160_v03.ino"
BASE = ROOT.parent / "fieldnote-integrated-v0.2/firmware/product_integrated_v02/product_integrated_v02.ino"


def function(source, name):
    start = re.search(r"^(?:bool|void|String|uint16_t) " + name + r"\([^;]*?\)\s*\{", source, re.M)
    if not start:
        raise AssertionError(f"missing function {name}")
    opening = source.index("{", start.start())
    level = 0
    state = "code"
    i = opening
    while i < len(source):
        c = source[i]
        nxt = source[i:i+2]
        if state == "code":
            if nxt == "//": state = "line"; i += 1
            elif nxt == "/*": state = "comment"; i += 1
            elif c in "\"'": state = c
            elif c == "{": level += 1
            elif c == "}":
                level -= 1
                if not level: return source[start.start():i+1]
        elif state == "line":
            if c == "\n": state = "code"
        elif state == "comment":
            if nxt == "*/": state = "code"; i += 1
        elif c == "\\": i += 1
        elif c == state: state = "code"
        i += 1
    raise AssertionError(f"unterminated function {name}")


source = SKETCH.read_text()
baseline = BASE.read_text()
assert hashlib.sha256(BASE.read_bytes()).hexdigest() == "e2ee4165b15578945648ea1db6d1b451c0dd2e0ec1d9d22e3437223cf309026a", "frozen v0.2 changed"
unchanged = ["crc16Ccitt", "parseNdefMessage", "parseNdefTlv", "parseFieldnoteRecord", "buildFieldnoteRecord", "chooseUriPrefix", "buildType2Ndef", "restoreClassic", "restoreType2", "writeClassicRecord", "writeType2Record"]
for name in unchanged:
    assert function(source, name) == function(baseline, name), f"product contract changed: {name}"
print(f"PASS {len(unchanged)} codec/CRC/rollback functions exactly match frozen v0.2")
handler = function(source, "handleWrite")
for contract in ('!confirmed || expectedUid.isEmpty()', 'value.length() > kMaxValueBytes', 'selectTag(freshUid', 'uidToString(freshUid, freshUidLength) != expectedUid', '!hardwareAllowsNfc()', 'sendError(409', 'sendError(500'):
    assert contract in handler, f"write authorization/result guard missing: {contract}"
assert 'pn7160.protocol() != expectedProtocol' in handler, "fresh selection must retain confirmed protocol"
assert 'userMemory(pn7160.protocol(), freshUidLength)' in handler, "write dispatch must use protocol/UID policy"
assert 'userMemory(next.protocol, uidLength)' in function(source, "updateTagSnapshot"), "read/write memory classification differs"
for route in ('server.on("/api/status", HTTP_GET, handleStatus)', 'server.on("/api/write", HTTP_POST, handleWrite)', 'server.on("/health", HTTP_GET'):
    assert route in source, f"API route changed: {route}"
assert 'document["pn532"]' in source, "legacy UI/API reader object changed"
assert 'kWifiPreferencesNamespace[] = "fieldnote"' in source and 'kWifiCredentialsKey[] = "wifi"' in source, "credential persistence identity changed"
print("PASS source review guards: explicit confirmation/fresh UID/36-byte limit/error branches/API and credential identity")

functions = ["bytesToString", "crc16Ccitt", "uriPrefix", "parseNdefMessage", "parseNdefTlv", "parseFieldnoteRecord", "authenticateClassic", "readClassicMemory", "readType2Memory", "writeClassicBlocks", "restoreClassic", "buildFieldnoteRecord", "writeClassicRecord", "chooseUriPrefix", "buildType2Ndef", "writeType2Pages", "restoreType2", "writeType2Record"]
fixture = r'''
#include <algorithm>
#include <array>
#include <cctype>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>
class String {
 public:
  std::string s;
  String() {} String(const char *p):s(p){} String(const std::string&p):s(p){}
  size_t length()const{return s.size();} bool isEmpty()const{return s.empty();}
  const char*c_str()const{return s.c_str();} void reserve(size_t n){s.reserve(n);}
  String&operator+=(char c){s+=c;return *this;} String&operator+=(const String&v){s+=v.s;return *this;}
  bool operator==(const char*p)const{return s==p;} bool operator==(const String&v)const{return s==v.s;}
  bool startsWith(const char*p)const{return s.compare(0,strlen(p),p)==0;}
  String substring(size_t n)const{return String(s.substr(n));}
  void toLowerCase(){for(char&c:s)c=static_cast<char>(std::tolower(static_cast<unsigned char>(c)));}
};
constexpr uint8_t kClassicFirstBlock=4,kClassicDataBlockCount=3,kType2FirstPage=4,kType2LastPage=15;
constexpr size_t kSafeMemoryBytes=48,kMaxValueBytes=36;
const uint8_t kClassicDefaultKey[6]={255,255,255,255,255,255};
const uint8_t kRecordMagic[8]={'N','F','C','W','E','B','0','1'};
static bool power=true;
static bool hardwareAllowsNfc(){return power;}
static void check(bool ok,const char*why){if(!ok)throw std::runtime_error(why);}
struct MockNfc {
 std::array<uint8_t,48> memory;
 std::vector<uint8_t> written;
 int failWriteAt=-1; bool cutPower=false; int calls=0;
 MockNfc(){reset();}
 void reset(){power=true;for(size_t i=0;i<memory.size();++i)memory[i]=static_cast<uint8_t>(0x60+i);written.clear();calls=0;failWriteAt=-1;cutPower=false;}
 bool authenticate(const uint8_t*,uint8_t,uint8_t block,const uint8_t*){check(block==4,"auth outside sector1");return power;}
 bool readBlock(uint8_t block,uint8_t*out){check(block>=4&&block<=6,"unsafe Classic read");if(!power)return false;memcpy(out,memory.data()+(block-4)*16,16);return true;}
 bool readPage(uint8_t page,uint8_t*out){check(page>=4&&page<=15,"unsafe Type2 read");if(!power)return false;memcpy(out,memory.data()+(page-4)*4,4);return true;}
 bool write(size_t offset,size_t n,uint8_t address,const uint8_t*data){check(power,"write after downgrade");written.push_back(address);memcpy(memory.data()+offset,data,n);++calls;if(calls==failWriteAt){if(cutPower)power=false;return false;}return true;}
 bool writeBlock(uint8_t block,const uint8_t*data){check(block>=4&&block<=6,"unsafe Classic write");return write((block-4)*16,16,block,data);}
 bool writePage(uint8_t page,const uint8_t*data){check(page>=4&&page<=15,"unsafe Type2 write");return write((page-4)*4,4,page,data);}
} pn7160;
'''
classic = bytearray(48)
classic[:8] = b"NFCWEB01"
classic[8:10] = bytes([1, 36])
classic[10:46] = b"A" * 36
classic[46:48] = binascii.crc_hqx(classic[:46], 0xFFFF).to_bytes(2, "little")
golden = ",".join(str(x) for x in classic)
body = r'''
int main(){
 unsigned cases=0;
 const uint8_t uid[4]={1,2,3,4}; uint8_t data[48]={},verified[48]={};String kind,value,error;
 const uint8_t vector[]={'1','2','3','4','5','6','7','8','9'};
 check(crc16Ccitt(vector,9)==0x29B1,"CCITT-FALSE reference vector");++cases;
 const uint8_t expected[48]={GOLDEN};
 check(buildFieldnoteRecord("text",String(std::string(36,'A')),data),"max record rejected");
 check(memcmp(expected,data,48)==0,"Classic layout/CRC byte order changed");
 check(parseFieldnoteRecord(data,kind,value)&&kind=="text"&&value.length()==36,"Classic roundtrip");++cases;
 data[20]^=1;check(!parseFieldnoteRecord(data,kind,value),"corrupt CRC accepted");
 check(!buildFieldnoteRecord("text","",data)&&!buildFieldnoteRecord("text",String(std::string(37,'A')),data),"Classic length bound");++cases;
 check(buildFieldnoteRecord("text",String(std::string(18,'x')+std::string(18,'y')),data),"36byte UTF8 budget");
 check(buildFieldnoteRecord("text",String(std::string("\xF0\x9F\x98\x80")+std::string(32,'x')),data),"36UTF8bytes rejected");
 check(!buildFieldnoteRecord("text",String(std::string("\xF0\x9F\x98\x80")+std::string(33,'x')),data),"37UTF8bytes accepted");++cases;
 check(buildType2Ndef("text",String(std::string(36,'A')),data),"NDEF max text");
 check(data[0]==3&&data[1]==43&&data[2]==0xD1&&data[4]==39&&data[5]=='T'&&data[6]==2&&data[7]=='e'&&data[8]=='n'&&data[45]==0xFE,"NDEF golden header/end");
 check(parseNdefTlv(data,48,kind,value)&&kind=="text"&&value.length()==36,"NDEF text roundtrip");++cases;
 check(buildType2Ndef("url","https://www.example.test/a",data),"URL build");
 check(data[5]=='U'&&data[6]==2,"URL compression prefix");
 check(parseNdefTlv(data,48,kind,value)&&kind=="url"&&value=="https://www.example.test/a","URL roundtrip");++cases;
 const uint8_t truncated[]={3,255,0};check(!parseNdefTlv(truncated,sizeof(truncated),kind,value),"truncated extended TLV accepted");
 const uint8_t excessive[]={3,255,255,255};check(!parseNdefTlv(excessive,sizeof(excessive),kind,value),"oversize TLV accepted");++cases;
 pn7160.reset();check(writeClassicRecord(uid,4,"text","new",verified,error),"Classic write/readback");
 check(pn7160.written==std::vector<uint8_t>({4,5,6}),"Classic safe write region");++cases;
 pn7160.reset();auto original=pn7160.memory;pn7160.failWriteAt=2;
 check(!writeClassicRecord(uid,4,"text","new",verified,error),"interrupted write succeeded");
 check(pn7160.memory==original&&error.s.find("restored")!=std::string::npos,"Classic rollback failed");++cases;
 pn7160.reset();pn7160.failWriteAt=2;pn7160.cutPower=true;
 check(!writeClassicRecord(uid,4,"text","new",verified,error),"powerlost write succeeded");
 check(pn7160.calls==2&&pn7160.memory!=original,"power downgrade ignored/partialdata not modeled");++cases;
 pn7160.reset();check(writeType2Record("text","new",verified,error),"Type2 write/readback");
 check(pn7160.written.size()==13&&pn7160.written.front()==4&&pn7160.written.back()==4,"Type2 TLV commit order");
 for(size_t i=1;i<12;++i)check(pn7160.written[i]==i+4,"Type2 safe body pages");++cases;
 pn7160.reset();original=pn7160.memory;pn7160.failWriteAt=5;
 check(!writeType2Record("text","new",verified,error),"interrupted Type2 succeeded");
 check(pn7160.memory==original&&error.s.find("restored")!=std::string::npos,"Type2 rollback failed");++cases;
 pn7160.reset();pn7160.failWriteAt=5;pn7160.cutPower=true;
 check(!writeType2Record("text","new",verified,error)&&pn7160.calls==5,"Type2 continued after downgrade");++cases;
 std::cout<<"PASS "<<cases<<" actual codec/rollback fixture cases (no physical tag or HTTP runtime proof)\n";
}
'''.replace("GOLDEN", golden)
with tempfile.TemporaryDirectory(prefix="fieldnote-pn7160-contract-") as temp:
    cpp = Path(temp) / "contracts.cpp"
    binary = Path(temp) / "contracts"
    cpp.write_text(fixture + "\n" + "\n\n".join(function(source, n) for n in functions) + "\n" + body)
    subprocess.run(["c++", "-std=c++11", "-Wall", "-Wextra", "-Werror", str(cpp), "-o", str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
