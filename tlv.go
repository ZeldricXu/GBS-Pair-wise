package main

import (
	"encoding/binary"
	"fmt"
)

// TLV 类型定义（厂商协议）。
const (
	TLVTemperature = 0x01 // 有符号，单位 0.1 ℃
	TLVHumidity    = 0x02 // 无符号，单位 0.1 %RH（假定，协议未注明）
	TLVVoltage     = 0x03 // 无符号，单位 0.1 V（假定，协议未注明）
	TLVStatus      = 0x04 // 状态码，无符号整型
)

// TLV 是一条 类型(1B)+长度(2B BE)+值 的记录。
type TLV struct {
	Type  byte
	Value []byte
}

// ParseTLVs 解析载荷中的 TLV 序列。遇到截断的记录即停止并返回已解析部分，
// 不让单条畸形 TLV 影响整帧已解析出的数据。
func ParseTLVs(payload []byte) []TLV {
	var out []TLV
	for len(payload) >= 3 {
		t := payload[0]
		l := int(binary.BigEndian.Uint16(payload[1:3]))
		payload = payload[3:]
		if l > len(payload) {
			break
		}
		v := make([]byte, l)
		copy(v, payload[:l])
		out = append(out, TLV{Type: t, Value: v})
		payload = payload[l:]
	}
	return out
}

// EncodeTLVs 把 TLV 列表编码为载荷字节。
func EncodeTLVs(tlvs []TLV) []byte {
	var out []byte
	for _, t := range tlvs {
		out = append(out, t.Type, byte(len(t.Value)>>8), byte(len(t.Value)))
		out = append(out, t.Value...)
	}
	return out
}

// DecodedReport 是上报载荷解码后的可读形式。
type DecodedReport struct {
	Temperature *float64 `json:"temperature_c,omitempty"`
	Humidity    *float64 `json:"humidity_rh,omitempty"`
	Voltage     *float64 `json:"voltage_v,omitempty"`
	Status      *uint16  `json:"status,omitempty"`
}

// DecodeReport 把 TLV 载荷解码成结构化读数。长度不符的字段跳过。
func DecodeReport(payload []byte) DecodedReport {
	var r DecodedReport
	for _, t := range ParseTLVs(payload) {
		switch t.Type {
		case TLVTemperature:
			if len(t.Value) == 2 {
				v := float64(int16(binary.BigEndian.Uint16(t.Value))) / 10
				r.Temperature = &v
			}
		case TLVHumidity:
			if len(t.Value) == 2 {
				v := float64(binary.BigEndian.Uint16(t.Value)) / 10
				r.Humidity = &v
			}
		case TLVVoltage:
			if len(t.Value) == 2 {
				v := float64(binary.BigEndian.Uint16(t.Value)) / 10
				r.Voltage = &v
			}
		case TLVStatus:
			if len(t.Value) == 2 {
				v := binary.BigEndian.Uint16(t.Value)
				r.Status = &v
			}
		}
	}
	return r
}

func (r DecodedReport) String() string {
	s := ""
	if r.Temperature != nil {
		s += fmt.Sprintf(" temp=%.1f℃", *r.Temperature)
	}
	if r.Humidity != nil {
		s += fmt.Sprintf(" rh=%.1f%%", *r.Humidity)
	}
	if r.Voltage != nil {
		s += fmt.Sprintf(" volt=%.1fV", *r.Voltage)
	}
	if r.Status != nil {
		s += fmt.Sprintf(" status=%d", *r.Status)
	}
	return s
}
